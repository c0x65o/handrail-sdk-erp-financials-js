import {readJournalAccountPolicy,type JournalAccountPolicyRequest,type JournalAccountPolicyPage} from "./journal-account-policy.js";
import { withAccountingReferenceGuard, type AccountingReferenceGuardRequest, type AccountingReferenceGuard } from "./accounting-reference-guard.js";
import { readReportingCalendar, type ReportingCalendarRequest, type ReportingCalendar } from "./reporting-calendar.js";
import { readCashFlowPurpose, type CashFlowPurposeCorrection } from "./cash-flow-purpose.js";
import { readCashFlowSummary, type CashFlowSummaryRequest, type CashFlowSummary } from "./cash-flow-summary.js";
import { scopedRecordId } from "./scoped-record-id.js";
import { readCanonicalFiscalCloseReadiness, readFiscalCloseDiagnostics, type CanonicalFiscalCloseReadiness, type FiscalCloseDiagnostics } from "./fiscal-close-diagnostics.js";
import { createHash } from "node:crypto";

import { ErpFinancialsError } from "./sdk-errors.js";

import type {
  AccountClassification,
  AccountingBasis,
  DecimalString,
  IsoCurrencyCode,
  IsoDate,
  IsoDateTime,
  JsonValue
} from "./canonical-model.js";
import type { ErpFinancialsTransactionRunner, JournalEntryOrigin } from "./erp-financials-service.js";
import type { PostgresQueryClient } from "./postgres-storage.js";
import type { ReportingBookAccountRole } from "./reporting-books.js";

export type PageRequest = {
  readonly limit?: number;
  readonly cursor?: string;
};

export type Page<Result> = {
  readonly items: readonly Result[];
  readonly nextCursor?: string;
};

/** One source account definition, without ledger balances or reporting aggregation.
 * This is presentation/intent metadata, never a posting eligibility guarantee.
 */
export type OperationalAccountDefinition = {
  readonly accountId: string;
  readonly sourceId: string;
  readonly sourceAccountId: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly type: string;
  readonly classification: AccountClassification;
  readonly active: boolean;
};
/** Bounded source-account metadata for command composition. No balances and no
 * posting authorization. Commands must revalidate under their lifecycle locks. */
export type OperationalAccountListRequest = PageRequest & {
  readonly sourceId: string; readonly asOfDate: IsoDate;
  readonly search?: string; readonly includeUnavailable?: boolean;
};
export type OperationalAccountListItem = OperationalAccountDefinition & {
  readonly bookAccountKey: string; readonly bookAccountName: string; readonly bookAccountNumber?: string;
  /** Source account active and mapped book account active/posting, at read time.
   * Does not cover permissions, fiscal state, source policy or later changes. */
  readonly accountEnabled: boolean;
};

/** Exact bounded metadata lookup for reviewed command lines. No balances or
 * posting authorization; missing/out-of-scope accounts reject the whole batch. */
export type OperationalAccountsRequest = {
  readonly sourceId: string; readonly accountIds: readonly string[]; readonly asOfDate: IsoDate;
};

export type OperationalAccountRequest = {
  readonly sourceId: string;
  readonly accountId: string;
  /** Scope source membership to the intended document date. */
  readonly asOfDate: IsoDate;
};

/** Resolve the key supplied to native account creation. This is neither an
 * account number, a provider sourceAccountId, nor a reporting book account key.
 * Imported accounts created only by ID must use getOperationalAccount instead.
 */
export type OperationalAccountKeyRequest = {
  readonly sourceId: string;
  readonly accountKey: string;
  readonly asOfDate: IsoDate;
};

/** Provider-neutral party identity exposed to operational applications. */
export type PartyListItem = {
  readonly partyId: string;
  readonly sourceId: string;
  readonly sourcePartyId: string;
  readonly partyType: "customer" | "vendor" | "employee" | "other";
  readonly displayName: string;
  readonly active: boolean;
};

export type OperationalDocumentType =
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

export type OperationalDocumentStatus =
  | "draft"
  | "open"
  | "partially_applied"
  | "settled"
  | "voided"
  | "replaced";

/** One provider-neutral operational register spanning native and imported subledgers. */
export type OperationalDocumentListItem = {
  readonly recognitionDate?: IsoDate;
  readonly documentId: string;
  readonly sourceId: string;
  readonly sourceSystem: string;
  readonly providerEnvironment: string;
  readonly documentType: OperationalDocumentType;
  readonly transactionId: string;
  readonly sourceTransactionId?: string;
  readonly sourceTransactionType?: string;
  readonly partyId?: string;
  readonly partyName?: string;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate?: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: OperationalDocumentStatus;
  readonly version: number;
  /** Current payment control, independent of historical asOfDate balances. */
  readonly paymentHold?: boolean;
  readonly paymentHoldReason?: string | null;
};

export type OperationalDocumentDetail = OperationalDocumentListItem & {
  readonly memo?: string;
  readonly lines: readonly CommercialDocumentLineReadModel[];
  readonly applications: readonly PaymentApplicationListItem[];
  readonly metadata?: JsonValue;
};

export type InvoiceListStatus = "draft" | "open" | "sent" | "overdue" | "partial" | "paid" | "voided";

export type InvoiceListItem = {
  /** Present when native recognition differs from the contractual documentDate. */
  readonly recognitionDate?: IsoDate;
  readonly invoiceId: string;
  readonly sourceId: string;
  readonly sourceProvenance: "draft" | "posted";
  readonly customerId: string;
  readonly customerName?: string;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: InvoiceListStatus;
  readonly version: number;
};

/** Current register: asOfDate selects overdue labels, not historical balances.
 * Summary covers the customer scope across every status, independently of the selected page/status. */
export type InvoiceRegisterStatus = "draft" | "open" | "overdue" | "paid" | "voided";
export type InvoiceRegisterFilter = InvoiceRegisterStatus | "active" | "receivable";
export type InvoiceRegisterRequest = PageRequest & { readonly asOfDate?: IsoDate; readonly customerId?: string; readonly status?: InvoiceRegisterFilter };
export type InvoiceRegisterItem = InvoiceListItem & { readonly registerStatus: InvoiceRegisterStatus; readonly memo?: string; readonly settlement: InvoiceSettlementSummary };
export type InvoiceRegisterSummary = {
  readonly counts: Readonly<Record<"all" | InvoiceRegisterStatus, string>>;
  readonly outstandingAmount: DecimalString; readonly overdueAmount: DecimalString; readonly draftAmount: DecimalString;
  /** Rounded unweighted age of current open invoices, clamped at zero for future dates. */
  readonly averageOpenAgeDays: string;
};
export type InvoiceRegisterPage = Page<InvoiceRegisterItem> & {
  readonly basis: "current"; readonly asOfDate: IsoDate; readonly currencyCode: IsoCurrencyCode;
  readonly revision: string; readonly summary: InvoiceRegisterSummary;
};

export type CommercialDocumentLineReadModel = {
  readonly taxAccountId?: string;
  readonly discountAccountId?: string;
  readonly accountNumber?: string;
  readonly lineId: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly itemId?: string;
  readonly description?: string;
  readonly quantity: DecimalString;
  readonly unitAmount: DecimalString;
  /** Immutable exact unit cost captured on the commercial line, when supplied. */
  readonly unitCost?: DecimalString;
  readonly discountAmount: DecimalString;
  readonly taxCode?: string;
  readonly taxAmount: DecimalString;
  readonly servicePeriodStart?: IsoDate;
  readonly servicePeriodEnd?: IsoDate;
  readonly dimensionRefs: JsonValue;
  readonly amount: DecimalString;
};

/** Bounded current commercial-line scan, including future/voided invoices. Draft
 * and posted lanes are disjoint: issued drafts only appear in the posted lane.
 * A cursor is scoped, not a snapshot token. Complete reconciliation must bind all
 * pages and both lanes to one caller-owned repeatable snapshot/write fence. */
export type CurrentInvoiceLineRequest = PageRequest & {
  readonly sourceId: string; readonly provenance: "draft" | "posted";
};
export type CurrentInvoiceLineItem = CommercialDocumentLineReadModel & {
  readonly invoiceId: string; readonly invoiceVersion: number;
};
export type CurrentInvoiceLinePage = Page<CurrentInvoiceLineItem> & {
  readonly basis: "current"; readonly sourceId: string;
  readonly provenance: "draft" | "posted"; readonly currencyCode: IsoCurrencyCode;
};

/** Current outstanding-balance composition, not cumulative receipts or a historical
 * cash-flow report. Ended applications are excluded; cancellation credit is
 * separate from ordinary credit. Unclassified reductions must never be called cash. */
export type InvoiceSettlementSummary = {
  readonly basis: "current";
  readonly cashAppliedAmount: DecimalString;
  readonly creditAppliedAmount: DecimalString;
  readonly writeOffAppliedAmount: DecimalString;
  readonly cancellationAmount: DecimalString;
  readonly unclassifiedAmount: DecimalString;
  readonly balanceReductionAmount: DecimalString;
};

export type InvoiceDetail = InvoiceListItem & {
  /** Returned by SDK 0.3.126+. Optional for source compatibility with older bindings. */
  readonly settlement?: InvoiceSettlementSummary;
  /** Storage timestamps, not document recognition dates. */
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly idempotencyKey: string;
  /** Original posted journal; absent for an unissued draft. */
  readonly transactionId?: string;
  /** Original create/post evidence, never inferred from a date or identifier. */
  readonly creationLifecycle?: FinancialLifecycleProvenance;
  readonly memo?: string;
  readonly lines: readonly CommercialDocumentLineReadModel[];
};

/** Current active cash application and immutable receipt provenance. One receipt
 * may occur more than once when separate allocations target this invoice. */
export type InvoiceReceiptApplication = {
  readonly applicationId: string;
  readonly applicationDate: IsoDate;
  readonly amount: DecimalString;
  readonly paymentId: string;
  readonly sourceId: string;
  readonly customerId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly paymentDate: IsoDate;
  readonly paymentCreatedAt: IsoDateTime;
  readonly paymentIdempotencyKey: string;
  readonly paymentTransactionId: string;
  readonly paymentMemo?: string;
  readonly paymentCreationLifecycle?: FinancialLifecycleProvenance;
};

export type InvoiceReceiptPageRequest = PageRequest & {
  /** Only selects overdue labeling. Balances and applications are current. */
  readonly asOfDate?: IsoDate;
};
export type InvoiceReceiptPage = Page<InvoiceReceiptApplication> & {
  readonly basis: "current";
  readonly asOfDate: IsoDate;
  readonly invoice: InvoiceDetail;
  readonly revision: string;
  readonly totalApplicationCount: number;
  readonly totalAppliedAmount: DecimalString;
  /** Maxima over all current cash allocations, not just this page. Receipt and
   * allocation dates differ for prepayments and later application/reapplication. */
  readonly latestReceiptDate?: IsoDate;
  readonly latestApplicationDate?: IsoDate;
};

/** Immutable lifecycle evidence related to one invoice, including its draft and applications. */
export type InvoiceAuditEvent = AccountingLifecycleProvenance & {
  readonly sourceId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: JsonValue;
};

/** Immutable bill, payment-instruction and application evidence for one vendor bill. */
export type VendorBillAuditEvent = InvoiceAuditEvent;

/** Canonical source identity for a customer-statement document. */
export type CustomerStatementSourceIdentity = {
  readonly sourceId: string;
  readonly sourceSystem: string;
  readonly providerEnvironment: string;
  readonly transactionId: string;
  readonly sourceTransactionId: string;
  readonly sourceTransactionType: string;
};

/** One application that reduces an invoice balance at the requested cutoff. */
export type CustomerStatementApplicationEvidence = {
  readonly applicationId: string;
  readonly applicationType: "customer_payment_to_invoice" | "credit_to_invoice" | "write_off_to_invoice";
  readonly status: "applied";
  readonly applicationDate: IsoDate;
  readonly amount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly sourceDocumentId: string;
  readonly sourceDocumentType: "customer_payment" | "credit_memo" | "write_off";
  readonly sourceDocumentNumber?: string;
  readonly sourceDocumentDate: IsoDate;
  readonly sourceIdentity: CustomerStatementSourceIdentity;
  readonly appliedLifecycleEventId: string;
  /** Present when the application was ended after this statement's cutoff. */
  readonly endedLifecycleEventId?: string;
};

/** Classified recorded applications effective at the statement cutoff. This is
 * allocated cash, not gross receipts. Cancelled invoices leave the statement on
 * the cancellation accounting date; their cancellation credit is not a payment. */
export type CustomerStatementSettlementAmounts = {
  readonly cashAppliedAmount: DecimalString;
  readonly creditAppliedAmount: DecimalString;
  readonly writeOffAppliedAmount: DecimalString;
};

/** One posted invoice and, when requested, canonical application evidence active at the cutoff. */
export type CustomerStatementRow = {
  readonly recognitionDate?: IsoDate;
  /** Returned by 0.3.127+; optional for older consumer source compatibility. */
  readonly settlement?: CustomerStatementSettlementAmounts;
  readonly invoiceId: string;
  readonly customerId: string;
  readonly customerName?: string;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate?: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly appliedAmount: DecimalString;
  readonly openBalance: DecimalString;
  readonly sourceIdentity: CustomerStatementSourceIdentity;
  readonly applications: readonly CustomerStatementApplicationEvidence[];
};

export type CustomerStatementTotals = {
  /** Classification of appliedAmount, independent of receipt totals. */
  readonly settlement?: CustomerStatementSettlementAmounts;
  readonly invoiceCount: number;
  readonly invoicedAmount: DecimalString;
  readonly appliedAmount: DecimalString;
  readonly outstandingAmount: DecimalString;
};

export type CustomerStatementRequest = PageRequest & {
  /** Default true for compatibility. False omits application JSON without changing amounts. */
  readonly includeApplications?: boolean;
  readonly customerId: string;
  readonly asOfDate: IsoDate;
};

/** Same-snapshot historical AR control amounts. Invoice totals remain gross;
 * positive available cash/credit amounts reduce netReceivableAmount. */
export type CustomerStatementBalance = {
  readonly invoiceOutstandingAmount: DecimalString;
  readonly unappliedCashAmount: DecimalString;
  readonly unappliedCreditAmount: DecimalString;
  readonly netReceivableAmount: DecimalString;
};

export type CustomerStatement = {
  /** Added in 0.3.178. Absence on older SDKs is not a zero balance. */
  readonly balance?: CustomerStatementBalance;
  readonly customerExists?: boolean;
  readonly customerName?: string;
  /** SDK-owned snapshot revision. A changed revision invalidates continuation cursors. */
  readonly revision?: string;
  /** True when applications arrays contain evidence; false when deliberately omitted. */
  readonly applicationsIncluded?: boolean;
  readonly customerId: string;
  readonly asOfDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly items: readonly CustomerStatementRow[];
  readonly nextCursor?: string;
  /** Authoritative totals for every matching invoice, independent of the current page. */
  readonly totals: CustomerStatementTotals;
  /** Totals that reconcile exactly to items on this page. */
  readonly pageTotals: CustomerStatementTotals;
};

export type OpenInvoiceReference = {
  readonly invoiceId: string;
  readonly documentNumber?: string;
  readonly dueDate: IsoDate;
  readonly openAmount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly version: number;
};

export type InvoiceDetailsByIdResult = {
  /** Found invoice IDs in the same relative order as the caller's request. */
  readonly orderedInvoiceIds: readonly string[];
  /** Only found, scope-visible invoices; use orderedInvoiceIds to reconstruct caller order. */
  readonly byInvoiceId: Readonly<Record<string, InvoiceDetail>>;
};

export type InvoiceDeliveryEvent = {
  readonly deliveryEventId: string;
  readonly invoiceId: string;
  readonly status: "sent" | "delivered" | "failed";
  readonly channel: string;
  readonly recipientRef?: string;
  readonly occurredAt: IsoDateTime;
  readonly lifecycleEventId: string;
};

export type VendorBillStatus = "open" | "overdue" | "partial" | "paid" | "voided" | "replaced";

const VENDOR_BILL_STATUSES: ReadonlySet<VendorBillStatus> = new Set([
  "open",
  "overdue",
  "partial",
  "paid",
  "voided",
  "replaced"
]);

export type VendorBillListItem = {
  /** Canonical ERP Financials bill identifier. */
  readonly billId: string;
  readonly sourceId: string;
  readonly sourceProvenance: "posted";
  readonly transactionId: string;
  readonly vendorId: string;
  readonly vendorName?: string;
  readonly documentNumber?: string;
  readonly documentDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly openAmount: DecimalString;
  readonly status: VendorBillStatus;
  readonly version: number;
  /** Current payment control, independent of historical asOfDate balances. */
  readonly paymentHold?: boolean;
  readonly paymentHoldReason?: string | null;
};

export type VendorBillLineReadModel = CommercialDocumentLineReadModel & {
  /** Stable account key from the source system; falls back to sourceId:accountId for legacy facts. */
  readonly sourceAccountKey: string;
  readonly sourceAccountName?: string;
  readonly bookAccountKey?: string;
  readonly accountMappingProvenance: "reporting_book_mapping" | "source_account";
  readonly accountMappingId?: string;
  readonly sourceItemId?: string;
  readonly itemName?: string;
  readonly itemCategoryAccountId?: string;
  readonly customerId?: string;
  readonly customerName?: string;
  readonly categoryMappingProvenance: "item_expense_account" | "line_account_override" | "uncategorized";
};

export type VendorBillApplicationReadModel = {
  readonly applicationId: string;
  readonly sourcePaymentId: string;
  readonly applicationDate: IsoDate;
  readonly amount: DecimalString;
  readonly status: "applied" | "unapplied" | "voided";
  readonly version: number;
};

/** Current native correction evidence, not a historical financial report or authorization. */
export type VendorBillCorrectionReviewRequest = PageRequest & { readonly sourceId: string; readonly billId: string };
export type VendorBillCorrectionReviewApplication = {
  readonly applicationId: string; readonly version: number;
  readonly applicationType: "bill_payment_to_bill" | "vendor_credit_to_bill";
  readonly applicationDate: IsoDate; readonly amount: DecimalString;
  readonly sourceDocumentId: string; readonly sourceDocumentType: "bill_payment" | "vendor_credit";
  readonly sourceVersion: number;
  /** Per-source balances: do not sum repeated source rows. */
  readonly sourceOpenAmount: DecimalString; readonly sourceOriginalAmount: DecimalString;
};
export type VendorBillCorrectionReviewPage = Page<VendorBillCorrectionReviewApplication> & {
  readonly bill: { readonly billId: string; readonly sourceId: string; readonly vendorId: string; readonly version: number;
    readonly documentDate: IsoDate; readonly dueDate: IsoDate; readonly currencyCode: IsoCurrencyCode;
    readonly originalAmount: DecimalString; readonly openAmount: DecimalString;
    readonly status: "open" | "partially_applied" | "settled" | "voided";
    readonly paymentHold: boolean; readonly paymentHoldReason: string | null };
  /** Detects changes to this bill and all active payment/credit sources between pages; not an approval token. */
  readonly reviewToken: string;
  readonly activeApplicationCount: string; readonly appliedAmount: DecimalString;
};

export type InvoiceCorrectionReviewRequest = PageRequest & { readonly sourceId: string; readonly invoiceId: string };
export type InvoiceCorrectionReviewApplication = {
  readonly applicationId: string; readonly version: number;
  readonly applicationType: "customer_payment_to_invoice" | "credit_to_invoice";
  readonly applicationDate: IsoDate; readonly amount: DecimalString;
  readonly sourceDocumentId: string; readonly sourceDocumentType: "customer_payment" | "credit_memo";
  readonly sourceVersion: number;
  /** Per-source balances: do not sum repeated source rows. */
  readonly sourceOpenAmount: DecimalString; readonly sourceOriginalAmount: DecimalString;
};
export type InvoiceCorrectionReviewPage = Page<InvoiceCorrectionReviewApplication> & {
  readonly invoice: { readonly invoiceId: string; readonly sourceId: string; readonly customerId: string; readonly version: number;
    readonly documentDate: IsoDate; readonly recognitionDate?: IsoDate; readonly dueDate: IsoDate; readonly currencyCode: IsoCurrencyCode;
    readonly originalAmount: DecimalString; readonly openAmount: DecimalString;
    readonly status: "open" | "partially_applied" | "settled" | "voided";
    readonly documentNumber?: string };
  /** Detects changes to this invoice and all active payment/credit sources between pages; not an approval token. */
  readonly reviewToken: string;
  readonly activeApplicationCount: string; readonly appliedAmount: DecimalString;
};

/** Current authoritative balances and holds, including future-dated documents.
 * Unlike the historical register, no as-of cutoff hides later native facts.
 * Ordered by canonical bill ID to use the existing source-scoped key index. */
export type CurrentVendorBillRequest = PageRequest & { readonly sourceId: string };
export type CurrentVendorBillItem = VendorBillCorrectionReviewPage["bill"] & {
  readonly transactionId: string; readonly documentNumber?: string;
};
export type CurrentVendorBillPage = Page<CurrentVendorBillItem> & {
  readonly basis: "current"; readonly sourceId: string; readonly currencyCode: IsoCurrencyCode;
};

export type VendorBillDetail = VendorBillListItem & {
  readonly memo?: string;
  readonly lines: readonly VendorBillLineReadModel[];
  readonly applications: readonly VendorBillApplicationReadModel[];
};

export type VendorBillSummary = {
  readonly asOfDate: IsoDate;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly outstandingAmount: DecimalString;
  readonly outstandingVendorBillCount: number;
  readonly overdueAmount: DecimalString;
  readonly overdueVendorBillCount: number;
  /** Cumulative amount applied to non-voided bills as of asOfDate. */
  readonly paidAmount: DecimalString;
  /** Amount applied during periodStart..periodEnd that remains applied as of asOfDate. */
  readonly paidInPeriodAmount: DecimalString;
  readonly paidInPeriodVendorBillCount: number;
  readonly settledVendorBillCount: number;
  readonly voidedVendorBillCount: number;
  readonly replacedVendorBillCount: number;
};

/** Register facets keep payment holds distinct from the financial balance status. */
export type VendorBillRegisterStatus = "open" | "overdue" | "on_hold" | "paid" | "voided" | "replaced";
export type VendorBillRegisterRequest = PageRequest & {
  readonly asOfDate?: IsoDate;
  readonly vendorId?: string;
  readonly status?: VendorBillRegisterStatus;
};
export type VendorBillRegisterItem = VendorBillListItem & {
  readonly registerStatus: VendorBillRegisterStatus;
  /** Includes payment and credit applications; terminal zero balances are not payments. */
  readonly appliedAmount: DecimalString;
  readonly paymentHold: boolean;
  readonly paymentHoldReason: string | null;
};
export type VendorBillRegisterSummary = {
  readonly asOfDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly outstandingAmount: DecimalString;
  readonly outstandingBillCount: string;
  /** Includes overdue held bills, because a hold does not extinguish the liability. */
  readonly overdueAmount: DecimalString;
  readonly overdueBillCount: string;
  /** Includes held bills due from asOfDate through dueSoonThrough, inclusive. */
  readonly dueSoonAmount: DecimalString;
  readonly dueSoonBillCount: string;
  readonly dueSoonThrough: IsoDate;
  /** Exact integer strings, global to the scope/vendor/date, not the selected status/page. */
  readonly counts: Readonly<Record<VendorBillRegisterStatus | "all", string>>;
};
export type VendorBillRegisterPage = Page<VendorBillRegisterItem> & { readonly summary: VendorBillRegisterSummary };

export type PaymentStatus = "unapplied" | "partial" | "applied" | "voided" | "returned";

const PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set(["unapplied", "partial", "applied", "voided", "returned"]);

export type PaymentListItem = {
  /** Present on customer payment pages when the native receipt owns an operational collection. */
  readonly collectionRef?: string;
  readonly paymentId: string;
  readonly sourceId: string;
  readonly paymentType: "customer_payment" | "bill_payment";
  /** Canonical immutable posting transaction for history-safe corrections. */
  readonly transactionId: string;
  readonly partyId: string;
  readonly partyName?: string;
  readonly documentNumber?: string;
  readonly paymentDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly unappliedAmount: DecimalString;
  /** Cash returned against this receipt, distinct from invoice/bill allocation. */
  readonly returnedAmount: DecimalString;
  /** Original payment less returned cash; zero for voided accounting documents. */
  readonly retainedAmount: DecimalString;
  readonly status: PaymentStatus;
  readonly version: number;
  /** Lifecycle event that originally posted the canonical payment. */
  readonly lifecycleEventId: string;
  readonly matchedApplicationCount: number;
};

export type CustomerPaymentProvenanceReadModel = {
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

export type PaymentApplicationMatchProvenance = {
  readonly matchCandidateId: string;
  readonly matchDecisionId: string;
  readonly method: "automatic" | "manual";
  readonly score: DecimalString;
  readonly evidence?: JsonValue;
};

export type PaymentApplicationListItem = {
  readonly applicationId: string;
  readonly sourceId: string;
  readonly applicationType: "customer_payment_to_invoice" | "bill_payment_to_bill" | "credit_to_invoice" | "vendor_credit_to_bill" | "write_off_to_invoice" | "customer_payment_to_refund";
  readonly status: "applied" | "unapplied" | "voided";
  readonly version: number;
  readonly applicationDate: IsoDate;
  readonly sourcePaymentId: string;
  readonly targetDocumentId: string;
  readonly amount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly appliedLifecycleEventId: string;
  readonly endedLifecycleEventId?: string;
  readonly matchProvenance?: PaymentApplicationMatchProvenance;
};

export type PaymentApplicationDetail = PaymentApplicationListItem;

/** Exact native command evidence, not an authorization or replay decision.
 * Historical applications may lack original versions; callers must not replace
 * them with current document versions. The apply command validates the complete
 * immutable payload and actor, and refuses to revive ended applications. */
export type PaymentApplicationCommandReceipt = {
  readonly application: PaymentApplicationDetail;
  readonly idempotencyKey: string;
  readonly originalExpectedVersions: { readonly source: number; readonly target: number } | null;
};

export type CustomerPaymentRegisterFilter = "all" | "automatic" | "manual" | "unapplied";
export type CustomerPaymentRegisterSort = "payment" | "customer" | "date" | "method" | "appliedTo" | "match" | "amount";
export type CustomerPaymentRegisterDirection = "asc" | "desc";
export type CustomerPaymentRegisterBoundary = {
  readonly sort: CustomerPaymentRegisterSort;
  readonly direction: CustomerPaymentRegisterDirection;
  readonly traversal: "forward" | "backward";
  readonly value: string | null;
  readonly paymentId: string;
};
export type CustomerPaymentRegisterApplication = PaymentApplicationListItem & {
  readonly targetDocumentNumber?: string;
  readonly targetDocumentVersion: number;
};
export type CustomerPaymentRegisterRow = PaymentListItem & {
  readonly applications: readonly CustomerPaymentRegisterApplication[];
  readonly sortValue: string | null;
  readonly matchingMode: "automatic" | "manual" | "unmatched";
  readonly match?: string;
  readonly paymentMethod?: string;
};
export type CustomerPaymentRegisterProjection = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly items: readonly CustomerPaymentRegisterRow[];
  readonly totalCount: number;
  readonly filteredAmount: DecimalString;
  readonly totals: {
    readonly receivedAmount: DecimalString;
    /** Current cash returned from receipts in the selected receipt-date cohort. */
    readonly returnedAmount: DecimalString;
    /** Current cash retained from that cohort, excluding voided documents. */
    readonly retainedAmount: DecimalString;
    readonly receivedPaymentCount: number;
    readonly unappliedAmount: DecimalString;
    readonly unappliedPaymentCount: number;
    readonly automaticallyMatchedPaymentCount: number;
    readonly matchedPaymentCount: number;
  };
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousBoundary?: CustomerPaymentRegisterBoundary;
  readonly nextBoundary?: CustomerPaymentRegisterBoundary;
};

/** Current unapplied cash in one immutable host collection. Live keyset pages,
 * not an as-of statement or reservation; commands must validate both versions. */
export type CollectionReceiptPageRequest = PageRequest & {
  readonly sourceId: string;
  readonly customerId: string;
  readonly collectionRef: string;
};
export type CollectionReceipt = {
  readonly paymentId: string;
  readonly sourceId: string;
  readonly customerId: string;
  readonly collectionRef: string;
  readonly paymentDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly unappliedAmount: DecimalString;
  readonly version: number;
  readonly documentNumber?: string;
};

/** Current collection facts for a host's immutable receipt grouping reference.
 * This is not a reservation or an as-of financial statement. */
export type ReceivableCollectionPositionRequest = {
  readonly sourceId: string;
  readonly customerId: string;
  readonly collectionRef: string;
  /** Posted invoice or draft identity. An issued draft resolves to its invoice. */
  readonly invoiceId?: string;
  /** Operational commercial amount, only before an SDK invoice/draft exists. */
  readonly unbilledAmount?: DecimalString;
};
/** A bounded page of host identities, returned in request order. Invalid or
 * duplicate identities reject the entire batch; empty input returns no rows. */
export type ReceivableCollectionPositionsRequest = {
  readonly requests: readonly ReceivableCollectionPositionRequest[];
};
/** Historical cash coverage of the CURRENT economic target and immutable
 * collection membership. Does not reconstruct prior commercial price changes.
 * firstCoveredOn is the first effective day coverage reached requiredAmount;
 * later refunds/reapplications do not rewrite that historical day. */
export type ReceivableCollectionCoverageHistory = {
  readonly sourceId: string;
  readonly customerId: string;
  readonly collectionRef: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly requiredAmount: DecimalString;
  readonly currentCashCoverageAmount: DecimalString;
  readonly firstCoveredOn: IsoDate | null;
};
/** This callback may write host operational state using the supplied client.
 * Financial facts are locked until its enclosing transaction ends. */
export type ReceivableCollectionGuard = {
  readonly positions: readonly ReceivableCollectionPosition[];
  readonly client: PostgresQueryClient;
};
export type ReceivableCollectionPosition = {
  readonly sourceId: string;
  readonly customerId: string;
  readonly collectionRef: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly basis: "unbilled" | "draft" | "invoice" | "voided";
  readonly invoiceId?: string;
  readonly invoiceVersion?: number;
  readonly originalAmount: DecimalString;
  readonly openInvoiceAmount: DecimalString;
  /** Unallocated, unreturned cash explicitly linked to this collection. */
  readonly unallocatedCashAmount: DecimalString;
  /** Current cash allocations to this invoice, including receipts from other groups. */
  readonly appliedCashAmount: DecimalString;
  readonly cashCoverageAmount: DecimalString;
  /** Remaining collection capacity after linked unused cash; never negative. */
  readonly collectionAmount: DecimalString;
  readonly receiptCount: number;
};

export type CustomerPaymentDetail = PaymentListItem & {
  /** Immutable host ownership grouping; absent on unclassified historical receipts. */
  readonly collectionRef?: string;
  /** Initial accepted receipt purpose, retained for command replay. Explicit
   * restatement is available through getCashFlowPurpose; this field never changes. */
  readonly cashFlowActivity?: "operating" | "investing" | "financing";
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly idempotencyKey: string;
  readonly creationLifecycle?: FinancialLifecycleProvenance;
  readonly memo?: string;
  readonly provenance?: CustomerPaymentProvenanceReadModel;
  /** Continuation for getCustomerPayment(paymentId, { cursor, limit }). */
  readonly applicationsNextCursor?: string;
  readonly applications: readonly PaymentApplicationListItem[];
};

export type FinancialLifecycleProvenance = {
  readonly lifecycleEventId: string;
  readonly actorRef: string;
  readonly approverRef?: string;
  readonly requestId: string;
  readonly reasonCode: string;
};

export type BillPaymentLifecycleEvidence = {
  readonly scheduled?: FinancialLifecycleProvenance;
  readonly cleared?: FinancialLifecycleProvenance;
  /** Low-level posting event retained for ledger audit compatibility. */
  readonly posted?: FinancialLifecycleProvenance;
  readonly voided?: FinancialLifecycleProvenance;
  readonly reversalTransactionId?: string;
};

export type BillPaymentLifecycleStatus = "scheduled" | "cleared" | "voided";

export type BillPaymentMethod = "ach" | "card" | "check";

const BILL_PAYMENT_LIFECYCLE_STATUSES: ReadonlySet<BillPaymentLifecycleStatus> = new Set([
  "scheduled",
  "cleared",
  "voided"
]);
const BILL_PAYMENT_METHODS: ReadonlySet<BillPaymentMethod> = new Set(["ach", "card", "check"]);

export type BillPaymentAccountEvidence = {
  readonly accountId: string;
  readonly postingId?: string;
  readonly debitAmount?: DecimalString;
  readonly creditAmount?: DecimalString;
};

export type BillPaymentListItem = {
  readonly paymentId: string;
  readonly sourceId: string;
  readonly paymentType: "bill_payment";
  readonly vendorId: string;
  /** Compatibility alias for generic payment consumers. */
  readonly partyId: string;
  readonly vendorName?: string;
  readonly partyName?: string;
  readonly documentNumber?: string;
  readonly paymentDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly status: BillPaymentLifecycleStatus;
  /** Optimistic version of the scheduled/cleared/voided disbursement lifecycle. */
  readonly version: number;
  readonly paymentMethod?: BillPaymentMethod;
  readonly reference?: string;
  readonly fundingAccountId?: string;
  readonly payableAccountId?: string;
  readonly transactionId?: string;
  readonly unappliedAmount?: DecimalString;
  readonly documentVersion?: number;
  readonly lifecycleEventId?: string;
  readonly applicationStatus?: PaymentStatus;
  readonly matchedApplicationCount: number;
};

export type BillPaymentCorrectionReviewRequest = PageRequest & { readonly sourceId: string; readonly paymentId: string };
export type BillPaymentCorrectionReviewApplication = {
  readonly applicationId: string; readonly version: number; readonly date: IsoDate; readonly amount: DecimalString;
  readonly billId: string; readonly billVersion: number; readonly billNumber: string | null;
  readonly billAmount: DecimalString; readonly billOpenAmount: DecimalString; readonly billStatus: string; readonly billPaymentHold: boolean;
};
export type BillPaymentCorrectionReviewPage = Page<BillPaymentCorrectionReviewApplication> & {
  readonly payment: { readonly paymentId: string; readonly sourceId: string; readonly vendorId: string; readonly date: IsoDate;
    readonly currencyCode: IsoCurrencyCode; readonly amount: DecimalString; readonly status: "scheduled" | "cleared";
    readonly version: number; readonly documentVersion: number | null; readonly unappliedAmount: DecimalString | null;
    readonly documentNumber: string | null; readonly reference: string | null; readonly paymentMethod: string | null;
    readonly fundingAccountId: string | null; readonly payableAccountId: string | null };
  /** Binds current payment and all active bill/application revisions. Not an authorization grant. */
  readonly reviewToken: string; readonly activeApplicationCount: string; readonly appliedAmount: DecimalString;
};

export type BillPaymentDetail = BillPaymentListItem & {
  readonly memo?: string;
  readonly lifecycle: BillPaymentLifecycleEvidence;
  readonly fundingAccount?: BillPaymentAccountEvidence;
  readonly payableAccount?: BillPaymentAccountEvidence;
  readonly applications: readonly PaymentApplicationListItem[];
};

/** Retained native instruction, not a balance report or authorization token.
 * Allocation versions belong to the original command, not today's bills.
 * recordAndApply must still validate the complete payload/actor and lifecycle. */
export type BillPaymentCommandReceipt = {
  readonly paymentId: string;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly status: BillPaymentLifecycleStatus;
  readonly version: number;
  readonly allocations: readonly { readonly billId: string; readonly amount: DecimalString; readonly expectedBillVersion: number }[];
};

export type BillPaymentSummary = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly scheduledAmount: DecimalString;
  readonly scheduledCount: number;
  readonly clearedAmount: DecimalString;
  readonly clearedCount: number;
  readonly voidedAmount: DecimalString;
  readonly voidedCount: number;
  readonly totalAmount: DecimalString;
  readonly totalCount: number;
};

export type WriteOffListItem = {
  readonly writeOffId: string;
  readonly sourceId: string;
  readonly transactionId: string;
  readonly customerId: string;
  readonly customerName?: string;
  readonly relatedInvoiceId?: string;
  readonly documentNumber?: string;
  readonly writeOffDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly status: "settled" | "voided" | "replaced";
  readonly version: number;
  readonly reason?: string;
  readonly reversalTransactionId?: string;
  readonly replacementWriteOffId?: string;
  readonly replacesWriteOffId?: string;
};

export type WriteOffDetail = WriteOffListItem & {
  readonly memo?: string;
  readonly balanceType: "receivable" | "payable";
  readonly balanceAccountId: string;
  readonly writeOffAccountId: string;
  readonly lifecycle: FinancialLifecycleProvenance;
};

export type AdjustmentType = "credit" | "refund";

export type AdjustmentStatus = "open" | "partially_applied" | "settled" | "voided" | "replaced";

export type AdjustmentListItem = {
  readonly adjustmentId: string;
  readonly sourceId: string;
  readonly transactionId: string;
  readonly adjustmentType: AdjustmentType;
  readonly customerId: string;
  readonly customerName?: string;
  readonly documentNumber?: string;
  readonly adjustmentDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly originalAmount: DecimalString;
  readonly remainingAmount: DecimalString;
  readonly status: AdjustmentStatus;
  readonly version: number;
  readonly reversalTransactionId?: string;
  readonly replacementAdjustmentId?: string;
  readonly replacesAdjustmentId?: string;
};

export type AdjustmentPostingReadModel = {
  readonly postingId: string;
  readonly accountId: string;
  readonly bookAccountKey: string;
  readonly accountName: string;
  readonly itemId?: string;
  readonly description?: string;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly dimensionRefs: JsonValue;
};

export type AdjustmentApplicationReadModel = {
  readonly applicationId: string;
  readonly invoiceId: string;
  readonly applicationDate: IsoDate;
  readonly amount: DecimalString;
  readonly status: "applied" | "unapplied" | "voided";
  readonly version: number;
};

export type AdjustmentDetail = AdjustmentListItem & {
  readonly memo?: string;
  readonly lines: readonly CommercialDocumentLineReadModel[];
  readonly postings: readonly AdjustmentPostingReadModel[];
  readonly applications: readonly AdjustmentApplicationReadModel[];
  readonly lifecycle?: FinancialLifecycleProvenance;
  readonly refundProvenance?: {
    readonly relatedInvoiceId?: string;
    readonly refundMethod?: string;
    readonly lifecycleReference?: string;
  };
};

export type AdjustmentRegisterFilter = "all" | "credit" | "refund" | "open";
export type AdjustmentRegisterSort =
  | "document"
  | "type"
  | "customer"
  | "date"
  | "reason"
  | "appliedTo"
  | "amount"
  | "status";
export type AdjustmentRegisterDirection = "asc" | "desc";
export type AdjustmentRegisterLifecycleStatus = "open" | "partially_applied" | "applied" | "voided" | "replaced";
export type AdjustmentRegisterBoundary = {
  readonly sort: AdjustmentRegisterSort;
  readonly direction: AdjustmentRegisterDirection;
  readonly traversal: "forward" | "backward";
  readonly value: string | null;
  readonly adjustmentId: string;
};
export type AdjustmentRegisterRow = {
  readonly adjustmentId: string;
  readonly sourceId: string;
  readonly transactionId: string;
  readonly adjustmentType: AdjustmentType;
  readonly customerId: string;
  readonly customerName?: string;
  readonly documentNumber?: string;
  readonly adjustmentDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly amount: DecimalString;
  readonly remainingAmount: DecimalString;
  readonly status: AdjustmentRegisterLifecycleStatus;
  readonly version: number;
  readonly reversalTransactionId?: string;
  readonly replacementAdjustmentId?: string;
  readonly replacesAdjustmentId?: string;
  readonly reason: string | null;
  readonly appliedInvoiceDocumentNumbers: readonly string[];
  readonly appliedTo: string | null;
  readonly sortValue: string | null;
};
export type AdjustmentRegisterProjection = {
  readonly quarterStart: IsoDate;
  readonly asOfDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly items: readonly AdjustmentRegisterRow[];
  readonly totalCount: number;
  readonly unfilteredCount: number;
  readonly totals: {
    readonly issuedAmount: DecimalString;
    readonly issuedCount: number;
    readonly unappliedAmount: DecimalString;
    readonly unappliedCount: number;
    readonly refundedAmount: DecimalString;
    readonly refundedCount: number;
  };
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousBoundary?: AdjustmentRegisterBoundary;
  readonly nextBoundary?: AdjustmentRegisterBoundary;
};

export type InvoiceSummary = {
  readonly asOfDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly outstandingAmount: DecimalString;
  readonly outstandingInvoiceCount: number;
  readonly overdueAmount: DecimalString;
  readonly overdueInvoiceCount: number;
  readonly unsentDraftAmount: DecimalString;
  readonly unsentDraftCount: number;
  /** Cash applied through customer-payment applications, excluding credits. */
  readonly collectedAmount: DecimalString;
  readonly settledInvoiceCount: number;
};

export type PaymentSummary = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly receivedAmount: DecimalString;
  /** Current cash returned from receipts in the selected receipt-date cohort. */
  readonly returnedAmount: DecimalString;
  /** Current cash retained from that cohort, excluding voided documents. */
  readonly retainedAmount: DecimalString;
  readonly receivedPaymentCount: number;
  readonly automaticallyMatchedPaymentCount: number;
  readonly matchedPaymentCount: number;
  readonly automaticMatchRatePercent: DecimalString;
  readonly unappliedAmount: DecimalString;
  readonly unappliedPaymentCount: number;
  readonly awaitingBankReviewCount: number;
};

export type GeneralLedgerSummary = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly postingCount: number;
  readonly totalDebits: DecimalString;
  readonly totalCredits: DecimalString;
  readonly difference: DecimalString;
};

export type GeneralLedgerPolarity = "debit" | "credit";

export type IncomeAttributionStatus = "assigned" | "unassigned" | "ambiguous";
export type IncomeAttributionRequest = PageRequest & {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingMethod?: ReportAccountingMethod;
  readonly sourceId?: string;
  readonly dimensionKind: string;
  readonly attributionStatus?: IncomeAttributionStatus;
  readonly reference?: { readonly kind: "dimension" | "source_dimension"; readonly id: string };
  readonly sort?: "identity" | "cost_desc" | "income_desc";
};
/** Same classification/sign convention as profit_and_loss statement totals. */
export type IncomeAttributionTotals = {
  readonly postingCount: string;
  readonly income: DecimalString;
  readonly costOfGoodsSold: DecimalString;
  readonly expenses: DecimalString;
  readonly grossProfit: DecimalString;
  readonly netIncome: DecimalString;
};
export type IncomeAttributionItem = IncomeAttributionTotals & {
  /** Opaque, source-qualified group identity. Never merge equal IDs across sources. */
  readonly key: string;
  readonly sourceId: string;
  readonly status: IncomeAttributionStatus;
  readonly dimensionId?: string;
  readonly sourceDimensionId?: string;
};
export type IncomeAttributionPage = Page<IncomeAttributionItem> & {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly dimensionKind: string;
  readonly revision: string;
  readonly groupCount: string;
  /** Whole requested scope, independent of pagination. Each P&L posting counts once. */
  readonly summary: IncomeAttributionTotals;
  readonly coverage: Readonly<Record<IncomeAttributionStatus, IncomeAttributionTotals>>;
  /** Additive since 0.3.106; current SDK always returns selection and matched.
   * Summary/coverage remain whole-scope controls; these are filtered controls. */
  readonly selection?: {
    readonly attributionStatus?: IncomeAttributionStatus;
    readonly reference?: { readonly kind: "dimension" | "source_dimension"; readonly id: string };
    readonly sort: "identity" | "cost_desc" | "income_desc";
  };
  readonly matched?: IncomeAttributionTotals & { readonly groupCount: string };
};

/** A report-time override; omission preserves the reporting book default. */
export type ReportAccountingMethod = Extract<AccountingBasis, "cash" | "accrual">;

/**
 * One validated filter contract is deliberately shared by the ledger page and
 * its summary cards so a host cannot accidentally summarize a different set of
 * postings than the rows it displays.
 */
export type GeneralLedgerFilters = {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingMethod?: ReportAccountingMethod;
  readonly accountKey?: string;
  readonly sourceId?: string;
  readonly transactionType?: string;
  /** Matches a canonical class dimension by dimensionId or sourceDimensionId. */
  readonly classId?: string;
  /** Generic canonical dimension filter; kind and id must be supplied together. */
  readonly dimensionKind?: string;
  readonly dimensionId?: string;
  readonly polarity?: GeneralLedgerPolarity;
  /** Literal, case-insensitive search. Wildcard characters have no special meaning. */
  readonly search?: string;
};

export type GeneralLedgerDimensionProvenance = {
  readonly dimensionKind: string;
  readonly dimensionId?: string;
  readonly sourceDimensionId?: string;
  readonly name?: string;
};

export type GeneralLedgerSourceProvenance = {
  readonly sourceId: string;
  readonly sourceRole: "historical" | "active" | "adjustment";
  readonly sourceSystem: string;
  readonly providerEnvironment: string;
  readonly sourceTransactionType: string;
  readonly sourceTransactionId: string;
  readonly sourcePostingId: string;
  readonly sourceObjectType?: string;
  readonly sourceObjectId?: string;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly checksum?: string;
};

export type GeneralLedgerLine = {
  readonly postingId: string;
  /** Canonical line linkage when present in journal posting detail. Imported
   * postings may have no transaction line; absence must not be inferred. */
  readonly transactionLineId?: string;
  readonly transactionLineNumber?: number;
  readonly sourceId: string;
  readonly transactionId: string;
  readonly transactionNumber?: string;
  readonly transactionDate: IsoDate;
  readonly postingDate: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly transactionType: string;
  readonly accountId: string;
  readonly bookAccountKey: string;
  readonly accountNumber?: string;
  readonly accountName: string;
  readonly partyId?: string;
  readonly itemId?: string;
  readonly description?: string;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly netAmount: DecimalString;
  /** Present for journal detail requested with includeIncomeEffect. */
  readonly accountClassification?: AccountClassification;
  readonly netIncomeEffect?: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly dimensions: readonly GeneralLedgerDimensionProvenance[];
  /** Number of canonical dimensions omitted after the public per-row bound. */
  readonly omittedDimensionCount: number;
  readonly sourceProvenance: GeneralLedgerSourceProvenance;
};

/** Exact source accounts, independent of reporting mappings/hierarchy. All
 * current posted facts in the book's source binding; no document-date cutoff. */
export type SourceAccountBalanceRequest = {
  readonly sourceId: string; readonly accountIds: readonly string[];
  readonly accountingMethod?: ReportAccountingMethod;
};
export type SourceAccountBalanceSummary = {
  readonly sourceId: string; readonly accountingBasis: AccountingBasis; readonly currencyCode: IsoCurrencyCode;
  readonly items: readonly { readonly accountId: string; readonly sourceAccountId: string; readonly accountNumber?: string;
    readonly classification: AccountClassification; readonly accountType: string;
    readonly debitAmount: DecimalString; readonly creditAmount: DecimalString; readonly netAmount: DecimalString; readonly postingCount: string }[];
};

/** One account's posted register. Balances are debit minus credit, never normal-side
 * presentation amounts. Default is direct activity; descendants require opt-in. */
export type AccountRegisterRequest = PageRequest & {
  readonly accountKey: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly sourceId?: string;
  readonly accountingMethod?: ReportAccountingMethod;
  readonly includeDescendants?: boolean;
};
export type AccountRegisterLine = GeneralLedgerLine & { readonly runningNet: DecimalString; readonly memo?: string };
export type AccountRegisterPage = Page<AccountRegisterLine> & {
  readonly account: { readonly bookAccountKey: string; readonly accountNumber?: string; readonly name: string; readonly classification: AccountClassification; readonly active: boolean };
  readonly periodStart: IsoDate; readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis; readonly currencyCode: IsoCurrencyCode;
  readonly openingNet: DecimalString; readonly debitAmount: DecimalString; readonly creditAmount: DecimalString;
  readonly closingNet: DecimalString; readonly postingCount: string; readonly revision: string;
};

/** Ordered display classification, not accounting authority or provenance.
 * Recorded origin modules take precedence; type patterns apply only without one. */
export type JournalOriginGroup = {
  readonly id: string;
  readonly originModules: readonly string[];
  readonly transactionTypeContains: readonly string[];
};

/** Posted journal register, including imported facts without a native preparation event.
 * Totals and first/last dates refer to postings in this window, not document dates.
 * Source document status never removes already-posted facts from this report. */
export type JournalRegisterRequest = PageRequest & {
  readonly periodStart: IsoDate; readonly periodEnd: IsoDate;
  readonly accountingMethod?: ReportAccountingMethod;
  /** SDK-owned P&L classification/effects, in the same snapshot as controls. */
  readonly includeIncomeEffect?: boolean;
  readonly sourceId?: string; readonly transactionType?: string;
  readonly originModule?: string; readonly search?: string;
  /** Exact canonical ID, transaction number or source transaction ID. */
  readonly reference?: string;
  readonly originGroups?: readonly JournalOriginGroup[];
  readonly originGroupId?: string;
};
export type JournalRegisterTotals = {
  readonly journalCount: string; readonly postingCount: string;
  readonly debitAmount: DecimalString; readonly creditAmount: DecimalString;
  readonly netIncomeEffect?: DecimalString;
};
export type JournalRegisterItem = {
  readonly transactionId: string; readonly transactionNumber?: string;
  readonly sourceId: string; readonly transactionDate: IsoDate;
  readonly firstPostingDate: IsoDate; readonly lastPostingDate: IsoDate;
  readonly documentStatus: string; readonly memo?: string;
  readonly postingCount: string; readonly debitAmount: DecimalString; readonly creditAmount: DecimalString;
  readonly netIncomeEffect?: DecimalString;
  readonly sourceProvenance: JournalEntrySourceProvenance;
  /** Absent for source facts with no SDK preparation event. Never synthesized. */
  readonly preparerProvenance?: AccountingLifecycleProvenance;
  /** Native immutable lifecycle links, if any; separate from imported document status. */
  readonly nativeStatus?: JournalEntryStatus;
  readonly originGroupId?: string;
};
export type JournalRegisterPage = Page<JournalRegisterItem> & {
  readonly periodStart: IsoDate; readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis; readonly currencyCode: IsoCurrencyCode;
  readonly revision: string;
  /** All posted facts in this book/window. Filters affect matched, not summary. */
  readonly summary: JournalRegisterTotals; readonly matched: JournalRegisterTotals;
  /** Counts after ordinary filters, before originGroupId; includes zero groups
   * and an explicit unclassified group. Same snapshot as rows and controls. */
  readonly originGroups?: readonly (JournalRegisterTotals & { readonly id: string })[];
};
export type JournalPostingRequest = PageRequest & {
  readonly sourceId: string; readonly transactionId: string;
  readonly periodStart: IsoDate; readonly periodEnd: IsoDate;
  readonly accountingMethod?: ReportAccountingMethod;
  /** SDK-owned P&L classification/effects, in the same snapshot as controls. */
  readonly includeIncomeEffect?: boolean;
};
export type JournalPostingPage = Page<GeneralLedgerLine> & {
  readonly journal: JournalRegisterItem;
  readonly periodStart: IsoDate; readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis; readonly currencyCode: IsoCurrencyCode;
  readonly revision: string;
};

export type AccountChartRequest = PageRequest & {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingMethod?: ReportAccountingMethod;
  readonly classification?: AccountClassification;
  readonly search?: string;
  readonly includeInactive?: boolean;
};
/** Resolve one reporting identity for a deep link without reading balances.
 * Account numbers must be unique in the visible reporting chart. */
export type ReportingAccountReferenceRequest = {
  readonly referenceType: "book_key" | "account_number";
  readonly reference: string;
  readonly asOfDate: IsoDate;
};

export type ReportingAccountDefinition = Omit<AccountChartItem, "direct" | "inclusive">;

export type AccountChartTotals = {
  readonly openingNet: DecimalString;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly closingNet: DecimalString;
  readonly postingCount: string;
};
export type AccountChartItem = {
  readonly bookAccountKey: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly type?: string;
  readonly subtype?: string;
  readonly accountRole?: ReportingBookAccountRole;
  readonly version?: number;
  readonly parentBookAccountKey?: string;
  readonly active: boolean;
  /** Posted directly to this account; safe to add across accounts. */
  readonly direct: AccountChartTotals;
  /** Direct plus every descendant once. Never add this to descendant totals. */
  readonly inclusive: AccountChartTotals;
};
export type AccountChartPage = Page<AccountChartItem> & {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly revision: string;
  readonly matchedAccountCount: string;
  /** Whole-book controls, independent of row filters and pagination. */
  readonly summary: AccountChartTotals & {
    readonly accountCount: string;
    readonly trialDebit: DecimalString;
    readonly trialCredit: DecimalString;
    readonly groups: readonly (AccountChartTotals & { readonly classification: AccountClassification; readonly accountCount: string })[];
  };
};

export type ChartOfAccountsItem = {
  readonly bookAccountKey: string;
  readonly sourceAccountIds: readonly string[];
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly type?: string;
  readonly subtype?: string;
  /** Present for a reporting-book-owned account; absent for an unmapped source fallback. */
  readonly accountRole?: ReportingBookAccountRole;
  /** Current mutation version for a reporting-book-owned account. */
  readonly version?: number;
  readonly parentBookAccountKey?: string;
  readonly active: boolean;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly directBalance: DecimalString;
  readonly balance: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
};

/** Gross outstanding invoices/bills only; unapplied credits/cash and drafts are
 * not obligations. Counts share one SQL snapshot and preserve historical dates. */
export type OutstandingDocumentSummary = {
  readonly tenantId: string; readonly companyId: string; readonly bookId: string;
  readonly asOfDate: IsoDate; readonly observedAt: IsoDateTime; readonly currencyCode: IsoCurrencyCode;
  readonly outstandingInvoiceCount: string; readonly overdueInvoiceCount: string;
  readonly outstandingVendorBillCount: string; readonly overdueVendorBillCount: string;
};

export type FinancialDashboardSummary = {
  readonly asOfDate: IsoDate;
  readonly periodStart: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly assets: DecimalString;
  readonly liabilities: DecimalString;
  readonly equity: DecimalString;
  readonly revenue: DecimalString;
  readonly expenses: DecimalString;
  readonly netIncome: DecimalString;
  /** Gross open issued invoices as of asOfDate; excludes unapplied receipts/credits. */
  readonly accountsReceivable: DecimalString;
  /** Gross open vendor bills as of asOfDate, including held obligations. */
  readonly accountsPayable: DecimalString;
  readonly overdueReceivables: DecimalString;
  readonly overduePayables: DecimalString;
};

export type FinancialStatementName = "profit_and_loss" | "balance_sheet" | "trial_balance";

export type FinancialStatementLine = {
  readonly bookAccountKey: string;
  readonly parentBookAccountKey?: string;
  readonly accountNumber?: string;
  readonly name: string;
  readonly classification: AccountClassification;
  /** Statement amount on this account before descendant roll-up, including derived earnings. */
  readonly directAmount: DecimalString;
  /** Activity on this account plus every descendant. */
  readonly amount: DecimalString;
  /** Portion of amount derived from P&L, including descendants, rather than this account's ledger.
   * Subtract from amount to recover the ledger portion. Present even when derived descendants cancel.
   * Lines containing derived earnings cannot be explained by an account-only ledger drilldown.
   */
  readonly derivedAmount?: DecimalString;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  /** Basis-locked filter that opens the exact canonical postings behind this line (including descendants). */
  readonly drilldown?: GeneralLedgerFilters;
};

export type FinancialStatementRequest = { readonly reportName: FinancialStatementName; readonly periodStart: IsoDate; readonly periodEnd: IsoDate; readonly asOfDate?: IsoDate; readonly accountingMethod?: ReportAccountingMethod };
/** At most 36 windows (twelve months for three statement types), never a ledger-row cap. */
export type FinancialStatementsRequest = { readonly statements: readonly FinancialStatementRequest[] };

export type FinancialStatement = {
  readonly reportName: FinancialStatementName;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly asOfDate: IsoDate;
  readonly accountingBasis: AccountingBasis;
  readonly currencyCode: IsoCurrencyCode;
  readonly lines: readonly FinancialStatementLine[];
  readonly totals: Readonly<Record<string, DecimalString>>;
};

export type AgingBucket = "current" | "days_1_30" | "days_31_60" | "days_61_90" | "days_over_90";

export type AgingRow = {
  readonly partyId: string;
  readonly partyName?: string;
  readonly current: DecimalString;
  readonly days1To30: DecimalString;
  readonly days31To60: DecimalString;
  readonly days61To90: DecimalString;
  readonly daysOver90: DecimalString;
  readonly total: DecimalString;
};

export type AgingReport = {
  readonly kind: "receivables" | "payables";
  readonly asOfDate: IsoDate;
  readonly currencyCode: IsoCurrencyCode;
  readonly rows: readonly AgingRow[];
  readonly totals: Omit<AgingRow, "partyId" | "partyName">;
};

/** Historical net AR (including unapplied receipts/credits) or gross AP.
 * Totals cover all nonzero parties, never just the returned page. */
export type AgingPageRequest = { readonly kind: "receivables" | "payables"; readonly asOfDate: IsoDate; readonly limit?: number; readonly cursor?: string };
export type AgingPage = AgingReport & { readonly basis: "as_of"; readonly partyCount: string; readonly revision: string; readonly nextCursor?: string };

/** Exact immutable hold command receipt. The original version is retained for
 * payload-idempotent recovery; it is not the bill's current optimistic version. */
export type VendorBillHoldCommandReceipt = {
  readonly lifecycleEventId: string;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly vendorBillId: string;
  readonly originalExpectedVersion: number;
  readonly resultingVersion: number;
  readonly paymentHold: boolean;
  readonly reason: string | null;
};

/** Exact immutable match instruction plus current lifecycle. Historical matches
 * remain readable but cannot supply a version they never retained. */
export type BankMatchCommandReceipt = {
  readonly bankReconciliationMatchId: string;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly bankStatementLineId: string;
  readonly transactionId: string;
  readonly method: "automatic" | "manual";
  readonly status: "matched" | "unmatched" | "voided";
  readonly version: number;
  readonly matchedAmount: DecimalString;
  readonly originalExpectedVersion: number | null;
};

type BankReconciliationListItemBase = {
  readonly bankStatementLineId: string;
  readonly sourceId: string;
  readonly bankAccountId: string;
  readonly externalLineId: string;
  readonly postedDate: IsoDate;
  readonly amount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
  readonly description?: string;
  readonly reference?: string;
  readonly version: number;
};

export type BankReconciliationListItem = BankReconciliationListItemBase & (
  | {
      readonly status: "matched";
      readonly bankReconciliationMatchId: string;
      readonly bankReconciliationMatchVersion: number;
      readonly matchedTransactionId: string;
      readonly matchMethod: "automatic" | "manual";
    }
  | {
      readonly status: "unmatched" | "ignored";
      readonly bankReconciliationMatchId?: undefined;
      readonly bankReconciliationMatchVersion?: undefined;
      readonly matchedTransactionId?: undefined;
      readonly matchMethod?: undefined;
    }
);

export type BankReconciliationSummary = {
  readonly currencyCode: IsoCurrencyCode;
  readonly unmatchedCount: number;
  readonly matchedCount: number;
  readonly ignoredCount: number;
  readonly unmatchedAbsoluteAmount: DecimalString;
  readonly matchedAbsoluteAmount: DecimalString;
};

export type AccountingLifecycleProvenance = {
  readonly lifecycleEventId: string;
  readonly eventType: string;
  readonly actorRef: string;
  readonly approverRef?: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly reasonDetail?: string;
  readonly occurredAt: IsoDateTime;
  readonly recordedAt: IsoDateTime;
  readonly payloadChecksum: string;
  readonly priorEventId?: string;
};

export type JournalEntryStatus = "posted" | "reversed" | "voided" | "corrected" | "replaced";

export type JournalEntrySourceProvenance = {
  readonly sourceId: string;
  readonly sourceRole: "historical" | "active" | "adjustment";
  readonly sourceSystem: string;
  readonly providerEnvironment: string;
  readonly sourceTransactionId: string;
  readonly sourceTransactionType: string;
  readonly sourceObjectType?: string;
  readonly sourceObjectId?: string;
  readonly sourceUpdatedAt?: IsoDateTime;
  readonly checksum?: string;
  readonly origin?: JournalEntryOrigin;
};

export type JournalEntryListItem = {
  readonly journalEntryId: string;
  /** The immutable first transaction in a reversal/correction/replacement chain. */
  readonly originalTransactionId: string;
  readonly sourceId: string;
  readonly transactionNumber?: string;
  readonly transactionDate: IsoDate;
  readonly postedAt: IsoDateTime;
  readonly memo?: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
  readonly status: JournalEntryStatus;
  readonly totalDebit: DecimalString;
  readonly totalCredit: DecimalString;
  readonly lineCount: number;
  /** One plus the number of immutable lifecycle links owned by this transaction. */
  readonly version: number;
  readonly sourceProvenance: JournalEntrySourceProvenance;
  readonly preparerProvenance: AccountingLifecycleProvenance;
};

export type JournalEntryAccountReference = {
  readonly accountId: string;
  readonly sourceAccountId: string;
  readonly bookAccountKey: string;
  readonly accountNumber?: string;
  readonly accountName: string;
  readonly classification: AccountClassification;
};

export type JournalEntryLineReadModel = {
  readonly transactionLineId: string;
  readonly postingId: string;
  readonly sourcePostingId: string;
  readonly lineNumber: number;
  readonly account: JournalEntryAccountReference;
  readonly partyId?: string;
  readonly itemId?: string;
  readonly description?: string;
  readonly debitAmount: DecimalString;
  readonly creditAmount: DecimalString;
  readonly netAmount: DecimalString;
  readonly dimensionRefs: JsonValue;
};

export type JournalEntryLifecycleLinkReadModel = {
  readonly journalEntryLinkId: string;
  readonly linkType: "reversal" | "void" | "correction" | "replacement";
  readonly originalTransactionId: string;
  readonly relatedTransactionId: string;
  readonly createdAt: IsoDateTime;
  readonly lifecycle: AccountingLifecycleProvenance;
};

export type JournalEntryDetail = JournalEntryListItem & {
  readonly lines: readonly JournalEntryLineReadModel[];
  readonly lifecycle: readonly AccountingLifecycleProvenance[];
  readonly links: readonly JournalEntryLifecycleLinkReadModel[];
};

export type FiscalPeriodReadModel = {
  readonly fiscalPeriodId: string;
  readonly sourceId: string;
  readonly fiscalYear: number;
  readonly periodNumber: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly status: "open" | "closing" | "closed";
  readonly version: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly canonicalCloseCertificateId?: string;
  readonly closeEvidence?: {
    readonly trialBalanceSnapshotId: string;
    readonly reconciliationRefs: readonly string[];
    readonly checklistRef: string;
    readonly postingMaxUpdatedAt: IsoDateTime;
    readonly evidenceChecksum: string;
  };
  readonly closeLifecycle?: AccountingLifecycleProvenance;
  readonly reopenLifecycle?: AccountingLifecycleProvenance;
  readonly latestLifecycle: AccountingLifecycleProvenance;
};

export type PostingLockReadModel = {
  readonly sourceId: string;
  readonly postingLockDate?: IsoDate;
  /** Zero denotes that no lock control has been created and is the create command's expectedVersion. */
  readonly version: number;
  readonly lifecycle?: AccountingLifecycleProvenance;
};

export type FinancialReadModels = {
  listUnappliedCollectionReceipts(input: CollectionReceiptPageRequest): Promise<Page<CollectionReceipt>>;
  getReceivableCollectionPosition(input: ReceivableCollectionPositionRequest): Promise<ReceivableCollectionPosition>;
  withLockedAccountingReferences<Result>(input: AccountingReferenceGuardRequest, work: (guard: AccountingReferenceGuard) => Promise<Result>): Promise<Result>;
  getReceivableCollectionPositions(input: ReceivableCollectionPositionsRequest): Promise<readonly ReceivableCollectionPosition[]>;
  getReceivableCollectionCoverageHistory(input: ReceivableCollectionPositionsRequest): Promise<readonly ReceivableCollectionCoverageHistory[]>;
  withLockedReceivableCollectionPositions<Result>(input: ReceivableCollectionPositionsRequest,
    work: (guard: ReceivableCollectionGuard) => Promise<Result>): Promise<Result>;
  listParties(input?: PageRequest & {
    readonly partyType?: PartyListItem["partyType"];
    readonly includeInactive?: boolean;
  }): Promise<Page<PartyListItem>>;
  listOperationalDocuments(input?: PageRequest & {
    readonly documentTypes?: readonly OperationalDocumentType[];
    readonly status?: OperationalDocumentStatus;
    readonly sourceId?: string;
    readonly partyId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
  }): Promise<Page<OperationalDocumentListItem>>;
  /** Current canonical state without lines/application history; not an as-of report. */
  getOperationalDocumentSummary(documentId: string, sourceId?: string): Promise<OperationalDocumentListItem>;
  getOperationalDocument(documentId: string): Promise<OperationalDocumentDetail>;
  listJournalEntries(input?: PageRequest & {
    /** Exact immutable source key, requiring sourceId and transactionType. */
    readonly sourceTransactionId?: string;
    readonly sourceId?: string;
    readonly status?: JournalEntryStatus;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly transactionType?: string;
    readonly preparerRef?: string;
    readonly search?: string;
  }): Promise<Page<JournalEntryListItem>>;
  getJournalEntry(journalEntryId: string): Promise<JournalEntryDetail>;
  listFiscalPeriods(input: PageRequest & {
    readonly sourceId: string;
    readonly status?: FiscalPeriodReadModel["status"];
    readonly fiscalYear?: number;
  }): Promise<Page<FiscalPeriodReadModel>>;
  getFiscalPeriod(sourceId: string, fiscalPeriodId: string): Promise<FiscalPeriodReadModel>;
  getReportingCalendar(input: ReportingCalendarRequest): Promise<ReportingCalendar>;
  getFiscalCloseDiagnostics(sourceId: string, fiscalPeriodId: string): Promise<FiscalCloseDiagnostics>;
  getCanonicalFiscalCloseReadiness(sourceId: string, fiscalPeriodId: string, bankAccountIds: readonly string[]): Promise<CanonicalFiscalCloseReadiness>;
  getPostingLock(sourceId: string): Promise<PostingLockReadModel>;
  listInvoices(input?: PageRequest & { readonly status?: InvoiceListStatus; readonly asOfDate?: IsoDate }): Promise<Page<InvoiceListItem>>;
  getInvoiceRegister(input?: InvoiceRegisterRequest): Promise<InvoiceRegisterPage>;
  /** Bounded current invoice/settlement summaries for known customer-owned identities.
   * Missing, foreign-customer and out-of-book IDs are omitted. No lines/history. */
  getInvoiceSummariesByIds(input: { readonly invoiceIds: readonly string[]; readonly customerId: string; readonly asOfDate?: IsoDate }): Promise<readonly InvoiceRegisterItem[]>;
  latestInvoiceNumberSequence(): Promise<number | null>;
  getOpenInvoicesByIds(invoiceIds: readonly string[]): Promise<readonly OpenInvoiceReference[]>;
  getInvoice(invoiceId: string, asOfDate?: IsoDate): Promise<InvoiceDetail>;
  getInvoiceReceiptPage(invoiceId: string, input?: InvoiceReceiptPageRequest): Promise<InvoiceReceiptPage>;
  getInvoicesByIds(invoiceIds: readonly string[], asOfDate?: IsoDate): Promise<InvoiceDetailsByIdResult>;
  listInvoiceDeliveries(invoiceId: string, input?: PageRequest): Promise<Page<InvoiceDeliveryEvent>>;
  listVendorBillAudit(billId: string, input?: PageRequest): Promise<Page<VendorBillAuditEvent>>;
  listInvoiceAudit(invoiceId: string, input?: PageRequest): Promise<Page<InvoiceAuditEvent>>;
  getInvoiceSummary(input?: { readonly asOfDate?: IsoDate }): Promise<InvoiceSummary>;
  getCustomerStatement(input: CustomerStatementRequest): Promise<CustomerStatement>;
  getCurrentInvoiceLinePage(input: CurrentInvoiceLineRequest): Promise<CurrentInvoiceLinePage>;
  getCurrentVendorBillPage(input: CurrentVendorBillRequest): Promise<CurrentVendorBillPage>;
  getVendorBillRegister(input?: VendorBillRegisterRequest): Promise<VendorBillRegisterPage>;
  listVendorBills(input?: PageRequest & { readonly status?: VendorBillStatus; readonly asOfDate?: IsoDate; readonly vendorId?: string }): Promise<Page<VendorBillListItem>>;
  getInvoiceCorrectionReview(input: InvoiceCorrectionReviewRequest): Promise<InvoiceCorrectionReviewPage>;
  getVendorBillCorrectionReview(input: VendorBillCorrectionReviewRequest): Promise<VendorBillCorrectionReviewPage>;
  getVendorBill(billId: string, asOfDate?: IsoDate): Promise<VendorBillDetail>;
  getVendorBillSummary(input?: {
    readonly asOfDate?: IsoDate;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly vendorId?: string;
  }): Promise<VendorBillSummary>;
  listPayments(input?: PageRequest & {
    readonly paymentType?: PaymentListItem["paymentType"];
    readonly vendorId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly status?: PaymentStatus;
  }): Promise<Page<PaymentListItem>>;
  listCustomerPaymentRegister(input: {
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly sort: CustomerPaymentRegisterSort;
    readonly direction: CustomerPaymentRegisterDirection;
    readonly limit: number;
    readonly filter?: CustomerPaymentRegisterFilter;
    readonly boundary?: CustomerPaymentRegisterBoundary;
  }): Promise<CustomerPaymentRegisterProjection>;
  findCustomerPaymentHistoryPartyIds(partyIds: readonly string[]): Promise<readonly string[]>;
  listBillPayments(input?: PageRequest & {
    readonly vendorId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly status?: BillPaymentLifecycleStatus;
    readonly paymentMethod?: BillPaymentMethod;
  }): Promise<Page<BillPaymentListItem>>;
  getCustomerPayment(paymentId: string, input?: PageRequest): Promise<CustomerPaymentDetail>;
  getBillPayment(paymentId: string): Promise<BillPaymentDetail>;
  findVendorBillHoldCommandByKey(input: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<VendorBillHoldCommandReceipt | null>;
  findBankMatchCommandByKey(input: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<BankMatchCommandReceipt | null>;
  findBillPaymentCommandByKey(input: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<BillPaymentCommandReceipt | null>;
  getBillPaymentCorrectionReview(input: BillPaymentCorrectionReviewRequest): Promise<BillPaymentCorrectionReviewPage>;
  getBillPaymentSummary(input: {
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly vendorId?: string;
    readonly status?: BillPaymentLifecycleStatus;
    readonly paymentMethod?: BillPaymentMethod;
  }): Promise<BillPaymentSummary>;
  listPaymentApplications(input?: PageRequest & {
    readonly applicationType?: PaymentApplicationListItem["applicationType"];
    readonly status?: PaymentApplicationListItem["status"];
    readonly sourcePaymentId?: string;
    readonly targetDocumentId?: string;
  }): Promise<Page<PaymentApplicationListItem>>;
  getPaymentApplication(applicationId: string): Promise<PaymentApplicationDetail>;
  findPaymentApplicationByKey(input: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<PaymentApplicationCommandReceipt | null>;
  getPaymentSummary(input: { readonly periodStart: IsoDate; readonly periodEnd: IsoDate }): Promise<PaymentSummary>;
  listAdjustments(input?: PageRequest & { readonly adjustmentType?: AdjustmentType; readonly status?: AdjustmentStatus }): Promise<Page<AdjustmentListItem>>;
  listAdjustmentRegister(input: {
    readonly asOfDate: IsoDate;
    readonly filter: AdjustmentRegisterFilter;
    readonly sort: AdjustmentRegisterSort;
    readonly direction: AdjustmentRegisterDirection;
    readonly limit: number;
    readonly boundary?: AdjustmentRegisterBoundary;
  }): Promise<AdjustmentRegisterProjection>;
  getAdjustment(adjustmentId: string): Promise<AdjustmentDetail>;
  listWriteOffs(input?: PageRequest & { readonly customerId?: string; readonly status?: WriteOffListItem["status"] }): Promise<Page<WriteOffListItem>>;
  getWriteOff(writeOffId: string): Promise<WriteOffDetail>;
  listGeneralLedger(input: PageRequest & GeneralLedgerFilters): Promise<Page<GeneralLedgerLine>>;
  getGeneralLedgerSummary(input: GeneralLedgerFilters): Promise<GeneralLedgerSummary>;
  getIncomeAttribution(input: IncomeAttributionRequest): Promise<IncomeAttributionPage>;
  getSourceAccountBalanceSummary(input: SourceAccountBalanceRequest): Promise<SourceAccountBalanceSummary>;
  getAccountRegister(input: AccountRegisterRequest): Promise<AccountRegisterPage>;
  getAccountChart(input: AccountChartRequest): Promise<AccountChartPage>;
  resolveReportingAccount(input: ReportingAccountReferenceRequest): Promise<ReportingAccountDefinition>;
  getJournalRegister(input: JournalRegisterRequest): Promise<JournalRegisterPage>;
  getJournalAccountPolicyPage(input:JournalAccountPolicyRequest):Promise<JournalAccountPolicyPage>;
  getJournalPostingPage(input: JournalPostingRequest): Promise<JournalPostingPage>;
  listOperationalAccounts(input: OperationalAccountListRequest): Promise<Page<OperationalAccountListItem>>;
  getOperationalAccounts(input: OperationalAccountsRequest): Promise<readonly OperationalAccountDefinition[]>;
  getOperationalAccount(input: OperationalAccountRequest): Promise<OperationalAccountDefinition>;
  getOperationalAccountByKey(input: OperationalAccountKeyRequest): Promise<OperationalAccountDefinition>;
  listChartOfAccounts(input?: { readonly asOfDate?: IsoDate; readonly includeInactive?: boolean }): Promise<readonly ChartOfAccountsItem[]>;
  getCashFlowPurpose(input: { sourceId: string; documentId: string }): Promise<CashFlowPurposeCorrection | null>;
  getCashFlowSummary(input: CashFlowSummaryRequest): Promise<CashFlowSummary>;
  getOutstandingDocumentSummary(input: { readonly asOfDate: IsoDate }): Promise<OutstandingDocumentSummary>;
  getDashboardSummary(input: { readonly periodStart: IsoDate; readonly asOfDate: IsoDate; readonly accountingMethod?: ReportAccountingMethod }): Promise<FinancialDashboardSummary>;
  getFinancialStatement(input: FinancialStatementRequest): Promise<FinancialStatement>;
  getFinancialStatements(input: FinancialStatementsRequest): Promise<readonly FinancialStatement[]>;
  getAging(input: { readonly kind: "receivables" | "payables"; readonly asOfDate: IsoDate }): Promise<AgingReport>;
  getAgingPage(input: AgingPageRequest): Promise<AgingPage>;
  listBankReconciliation(input?: PageRequest & { readonly status?: BankReconciliationListItem["status"] }): Promise<Page<BankReconciliationListItem>>;
  getBankReconciliationSummary(): Promise<BankReconciliationSummary>;
};

type Scope = {
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
};

type ResolvedBook = {
  readonly currencyCode: IsoCurrencyCode;
  readonly accountingBasis: AccountingBasis;
};

export function createFinancialReadModels(input: Scope): FinancialReadModels {
  assertNonEmpty(input.tenantId, "tenantId");
  assertNonEmpty(input.companyId, "companyId");
  assertNonEmpty(input.bookId, "bookId");
  return {
    listUnappliedCollectionReceipts: request => listUnappliedCollectionReceipts(input, request),
    getReceivableCollectionPosition: request => getReceivableCollectionPosition(input, request),
    getReceivableCollectionPositions: request => getReceivableCollectionPositions(input, request),
    getReceivableCollectionCoverageHistory: request => getReceivableCollectionCoverageHistory(input, request),
    withLockedAccountingReferences: (request, work) => withAccountingReferenceGuard(input, request, work),
    withLockedReceivableCollectionPositions: (request, work) => withLockedReceivableCollectionPositions(input, request, work),
    listParties: (request = {}) => listParties(input, request),
    listOperationalDocuments: (request = {}) => listOperationalDocuments(input, request),
    getOperationalDocumentSummary: (documentId, sourceId) => getOperationalDocumentSummary(input, documentId, sourceId),
    getOperationalDocument: (documentId) => getOperationalDocument(input, documentId),
    listJournalEntries: (request = {}) => listJournalEntries(input, request),
    getJournalEntry: (journalEntryId) => getJournalEntry(input, journalEntryId),
    listFiscalPeriods: (request) => listFiscalPeriods(input, request),
    getReportingCalendar: request => readReportingCalendar(input, request),
    getFiscalPeriod: (sourceId, fiscalPeriodId) => getFiscalPeriod(input, sourceId, fiscalPeriodId),
    getFiscalCloseDiagnostics: (sourceId, fiscalPeriodId) => {
      assertReadFilterText(sourceId, "sourceId"); assertReadFilterText(fiscalPeriodId, "fiscalPeriodId");
      return input.database.transaction(async client => {
        await resolveBook(client, input);
        return readFiscalCloseDiagnostics(client, { ...input, sourceId, fiscalPeriodId });
      });
    },
    getCanonicalFiscalCloseReadiness: (sourceId, fiscalPeriodId, bankAccountIds) => {
      assertReadFilterText(sourceId, "sourceId"); assertReadFilterText(fiscalPeriodId, "fiscalPeriodId");
      const ids = [...bankAccountIds];
      return input.database.transaction(async client => {
        await resolveBook(client, input);
        return readCanonicalFiscalCloseReadiness(client, { ...input, sourceId, fiscalPeriodId, bankAccountIds: ids });
      });
    },
    getPostingLock: (sourceId) => getPostingLock(input, sourceId),
    listInvoices: (request = {}) => listInvoices(input, request),
    latestInvoiceNumberSequence: () => latestInvoiceNumberSequence(input),
    getOpenInvoicesByIds: (invoiceIds) => getOpenInvoicesByIds(input, invoiceIds),
    getInvoice: (invoiceId, asOfDate) => getInvoice(input, invoiceId, asOfDate),
    getInvoiceRegister: (request = {}) => getInvoiceRegister(input, request),
    getInvoiceSummariesByIds: (request) => getInvoiceSummariesByIds(input, request),
    getInvoiceReceiptPage: (invoiceId, request = {}) => getInvoiceReceiptPage(input, invoiceId, request),
    getInvoicesByIds: (invoiceIds, asOfDate) => getInvoicesByIds(input, invoiceIds, asOfDate),
    listInvoiceDeliveries: (invoiceId, request = {}) => listInvoiceDeliveries(input, invoiceId, request),
    listVendorBillAudit: (billId, request = {}) => listVendorBillAudit(input, billId, request),
    listInvoiceAudit: (invoiceId, request = {}) => listInvoiceAudit(input, invoiceId, request),
    getInvoiceSummary: (request = {}) => getInvoiceSummary(input, request),
    getCustomerStatement: (request) => getCustomerStatement(input, request),
    getCurrentInvoiceLinePage: request => getCurrentInvoiceLinePage(input, request),
    getCurrentVendorBillPage: request => getCurrentVendorBillPage(input, request),
    getVendorBillRegister: (request = {}) => getVendorBillRegister(input, request),
    listVendorBills: (request = {}) => listVendorBills(input, request),
    getInvoiceCorrectionReview: request => getInvoiceCorrectionReview(input, request),
    getVendorBillCorrectionReview: request => getVendorBillCorrectionReview(input, request),
    getVendorBill: (billId, asOfDate) => getVendorBill(input, billId, asOfDate),
    getVendorBillSummary: (request = {}) => getVendorBillSummary(input, request),
    listPayments: (request = {}) => listPayments(input, request),
    listCustomerPaymentRegister: (request) => listCustomerPaymentRegister(input, request),
    findCustomerPaymentHistoryPartyIds: (partyIds) => findCustomerPaymentHistoryPartyIds(input, partyIds),
    listBillPayments: (request = {}) => listBillPayments(input, request),
    getCustomerPayment: (paymentId, request = {}) => getCustomerPayment(input, paymentId, request),
    getBillPayment: (paymentId) => getBillPayment(input, paymentId),
    findVendorBillHoldCommandByKey: request => findVendorBillHoldCommandByKey(input, request),
    findBankMatchCommandByKey: request => findBankMatchCommandByKey(input, request),
    findBillPaymentCommandByKey: request => findBillPaymentCommandByKey(input, request),
    getBillPaymentCorrectionReview: request => getBillPaymentCorrectionReview(input, request),
    getBillPaymentSummary: (request) => getBillPaymentSummary(input, request),
    listPaymentApplications: (request = {}) => listPaymentApplications(input, request),
    getPaymentApplication: (applicationId) => getPaymentApplication(input, applicationId),
    findPaymentApplicationByKey: request => findPaymentApplicationByKey(input, request),
    getPaymentSummary: (request) => getPaymentSummary(input, request),
    listAdjustments: (request = {}) => listAdjustments(input, request),
    listAdjustmentRegister: (request) => listAdjustmentRegister(input, request),
    getAdjustment: (adjustmentId) => getAdjustment(input, adjustmentId),
    listWriteOffs: (request = {}) => listWriteOffs(input, request),
    getWriteOff: (writeOffId) => getWriteOff(input, writeOffId),
    listGeneralLedger: (request) => listGeneralLedger(input, request),
    getGeneralLedgerSummary: (request) => getGeneralLedgerSummary(input, request),
    getIncomeAttribution: (request) => getIncomeAttribution(input, request),
    getSourceAccountBalanceSummary: request => getSourceAccountBalanceSummary(input,request),
    getAccountRegister: (request) => getAccountRegister(input, request),
    getAccountChart: (request) => getAccountChart(input, request),
    resolveReportingAccount: (request) => resolveReportingAccount(input, request),
    getJournalRegister: (request) => readJournalReport(input, request),
    getJournalAccountPolicyPage: request => input.database.transaction(async client=>{await resolveBook(client,input);return readJournalAccountPolicy(client,input,request);}),
    getJournalPostingPage: (request) => readJournalReport(input, request, true),
    listOperationalAccounts: (request) => listOperationalAccounts(input, request),
    getOperationalAccounts: request => getOperationalAccounts(input,request),
    getOperationalAccount: (request) => getOperationalAccount(input, request),
    getOperationalAccountByKey: (request) => getOperationalAccountByKey(input, request),
    listChartOfAccounts: (request = {}) => listChartOfAccounts(input, request),
    getCashFlowPurpose: request => readCashFlowPurpose(input, request),
    getCashFlowSummary: request => readCashFlowSummary(input, request, reportingAccountDefinitionsSql(4)),
    getOutstandingDocumentSummary: request => getOutstandingDocumentSummary(input, request),
    getDashboardSummary: (request) => getDashboardSummary(input, request),
    getFinancialStatement: (request) => getFinancialStatement(input, request),
    getFinancialStatements: request => getFinancialStatements(input, request),
    getAging: (request) => getAging(input, request),
    getAgingPage: (request) => getAging(input, request, true),
    listBankReconciliation: (request = {}) => listBankReconciliation(input, request),
    getBankReconciliationSummary: () => getBankReconciliationSummary(input)
  };
}

async function listParties(
  scope: Scope,
  input: PageRequest & {
    readonly partyType?: PartyListItem["partyType"];
    readonly includeInactive?: boolean;
  }
): Promise<Page<PartyListItem>> {
  const page = pageInput(input, `parties:${input.partyType ?? "all"}:${input.includeInactive === true ? "all" : "active"}`, scope.bookId);
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `select party."party_id", party."source_id", party."source_party_id", party."party_type",
  party."display_name", party."active"
from "erp_financials"."parties" party
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = party."tenant_id" and source."company_id" = $2
 and source."book_id" = $3 and source."source_id" = party."source_id"
where party."tenant_id" = $1
  and ($4::text is null or party."party_type" = $4)
  and ($5::boolean or party."active")
  and ($6::text is null or party."party_id" > $6)
order by party."party_id"
limit $7`,
      [scope.tenantId, scope.companyId, scope.bookId, input.partyType, input.includeInactive === true, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(partyFromRow), page.limit,
      `parties:${input.partyType ?? "all"}:${input.includeInactive === true ? "all" : "active"}`,
      scope.bookId,
      (item) => ({ date: "0001-01-01", id: item.partyId }));
  });
}

async function listOperationalDocuments(
  scope: Scope,
  input: PageRequest & {
    readonly documentTypes?: readonly OperationalDocumentType[];
    readonly status?: OperationalDocumentStatus;
    readonly sourceId?: string;
    readonly partyId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly documentId?: string;
  }
): Promise<Page<OperationalDocumentListItem>> {
  const kinds = input.documentTypes === undefined ? "all" : [...input.documentTypes].sort().join(",");
  const pageKind = `operational-documents:${kinds}:${input.status ?? "all"}:${input.sourceId ?? "all"}:${input.partyId ?? "all"}:${input.periodStart ?? "all"}:${input.periodEnd ?? "all"}`;
  const page = pageInput(input, pageKind, scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `select document."subledger_document_id" as "document_id", document."source_id",
  accounting_source."source_system", accounting_source."provider_environment", document."document_type",
  document."transaction_id", transaction."source_transaction_id", transaction."source_transaction_type",
  document."party_id", party."display_name" as "party_name", document."document_number",
  document."document_date"::text as "document_date", document."recognition_date"::text as "recognition_date", document."due_date"::text as "due_date", document."currency_code", document."original_amount",
  document."open_amount", document."status", document."version", document."payment_hold", document."payment_hold_reason"
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" book_source
  on book_source."tenant_id" = document."tenant_id" and book_source."company_id" = document."company_id"
 and book_source."book_id" = $3 and book_source."source_id" = document."source_id"
 and (book_source."effective_from" is null or book_source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (book_source."effective_through" is null or book_source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
join "erp_financials"."accounting_sources" accounting_source
  on accounting_source."tenant_id" = document."tenant_id" and accounting_source."source_id" = document."source_id"
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
left join "erp_financials"."parties" party
  on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
 and party."party_id" = document."party_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."currency_code" = $4
  and ($5::text[] is null or document."document_type" = any($5::text[]))
  and ($6::text is null or document."status" = $6)
  and ($7::text is null or document."source_id" = $7)
  and ($8::text is null or document."party_id" = $8)
  and ($9::date is null or document."document_date" >= $9)
  and ($10::date is null or document."document_date" <= $10)
  and ($11::text is null or document."subledger_document_id" = $11)
  and ($12::date is null or (document."document_date", document."subledger_document_id") < ($12::date, $13::text))
order by document."document_date" desc, document."subledger_document_id" desc
limit $14`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode,
        input.documentTypes, input.status, input.sourceId, input.partyId, input.periodStart, input.periodEnd,
        input.documentId, page.date, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(operationalDocumentFromRow), page.limit, pageKind, scope.bookId, (item) => ({
      date: item.documentDate,
      id: item.documentId
    }));
  });
}

async function getOperationalDocumentSummary(scope: Scope, documentId: string, sourceId?: string): Promise<OperationalDocumentListItem> {
  assertNonEmpty(documentId, "documentId");
  if (sourceId !== undefined) assertNonEmpty(sourceId, "sourceId");
  const page = await listOperationalDocuments(scope, { documentId, ...(sourceId === undefined ? {} : { sourceId }), limit: 1 });
  const document = page.items[0];
  if (document === undefined) {
    throw new ErpFinancialsError(
      "missing_document",
      `Operational document ${documentId} does not exist in reporting book ${scope.bookId}`,
      { details: { documentId, bookId: scope.bookId } }
    );
  }
  return document;
}

async function getOperationalDocument(scope: Scope, documentId: string): Promise<OperationalDocumentDetail> {
  const document = await getOperationalDocumentSummary(scope, documentId);
  return scope.database.transaction(async (client) => {
    const [header, lines, outgoing, incoming] = await Promise.all([
      client.query(
        `select transaction."memo", document."metadata"
from "erp_financials"."subledger_documents" document
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."source_id" = $3
  and document."subledger_document_id" = $4`,
        [scope.tenantId, scope.companyId, document.sourceId, document.documentId]
      ),
      client.query(
        `select "subledger_document_line_id" as "line_id", *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end"
from "erp_financials"."subledger_document_lines"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
order by "line_number"`,
        [scope.tenantId, scope.companyId, document.sourceId, document.documentId]
      ),
      queryPaymentApplications(client, scope, { sourcePaymentId: document.documentId }),
      queryPaymentApplications(client, scope, { targetDocumentId: document.documentId })
    ]);
    const applications = new Map([...outgoing, ...incoming].map((application) => [application.applicationId, application]));
    const row = header.rows[0];
    const memo = optionalString(row?.memo);
    const metadata = optionalJson(row?.metadata);
    return {
      ...document,
      ...(memo === undefined ? {} : { memo }),
      lines: lines.rows.map(commercialLineFromRow),
      applications: [...applications.values()].sort((left, right) =>
        right.applicationDate.localeCompare(left.applicationDate) || right.applicationId.localeCompare(left.applicationId)
      ),
      ...(metadata === undefined ? {} : { metadata })
    };
  });
}

type JournalEntryFilters = {
  readonly sourceTransactionId?: string;
  readonly sourceId?: string;
  readonly status?: JournalEntryStatus;
  readonly periodStart?: IsoDate;
  readonly periodEnd?: IsoDate;
  readonly transactionType?: string;
  readonly preparerRef?: string;
  readonly search?: string;
};

async function listJournalEntries(
  scope: Scope,
  input: PageRequest & JournalEntryFilters
): Promise<Page<JournalEntryListItem>> {
  const filters = journalEntryFilters(input);
  const pageKind = `journal-entries:${readFilterFingerprint(filters)}`;
  const page = pageInput(input, pageKind, scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with journal as (
  select transaction."transaction_id" as "journal_entry_id",
    coalesce(inbound."original_transaction_id", transaction."transaction_id") as "original_transaction_id",
    transaction."source_id", transaction."source_transaction_id", transaction."source_transaction_type",
    transaction."transaction_number", transaction."transaction_date", transaction."posted_at", transaction."memo",
    transaction."currency_code", posting."accounting_basis", posting."total_debit", posting."total_credit",
    posting."line_count", source."source_role", accounting_source."source_system",
    accounting_source."provider_environment", transaction."source_payload_ref",
    case
      when links."replacement_count" > 0 then 'replaced'
      when links."correction_count" > 0 then 'corrected'
      when links."void_count" > 0 then 'voided'
      when links."reversal_count" > 0 then 'reversed'
      else 'posted'
    end as "canonical_status",
    1 + links."link_count" as "version",
    prepared."event_id" as "preparer_event_id", prepared."event_type" as "preparer_event_type",
    prepared."actor_ref" as "preparer_actor_ref", prepared."approver_ref" as "preparer_approver_ref",
    prepared."request_id" as "preparer_request_id", prepared."correlation_id" as "preparer_correlation_id",
    prepared."reason_code" as "preparer_reason_code", prepared."reason_detail" as "preparer_reason_detail",
    prepared."occurred_at" as "preparer_occurred_at", prepared."recorded_at" as "preparer_recorded_at",
    prepared."payload_checksum" as "preparer_payload_checksum", prepared."prior_event_id" as "preparer_prior_event_id"
  from "erp_financials"."transactions" transaction
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3
   and source."source_id" = transaction."source_id"
   and (source."effective_from" is null or source."effective_from" <= transaction."transaction_date")
   and (source."effective_through" is null or source."effective_through" >= transaction."transaction_date")
  join "erp_financials"."accounting_sources" accounting_source
    on accounting_source."tenant_id" = transaction."tenant_id" and accounting_source."source_id" = transaction."source_id"
  join lateral (
    select coalesce(sum(posting."debit_amount"), 0) as "total_debit",
      coalesce(sum(posting."credit_amount"), 0) as "total_credit", count(*)::integer as "line_count",
      min(posting."accounting_basis") as "accounting_basis"
    from "erp_financials"."ledger_postings" posting
    where posting."tenant_id" = transaction."tenant_id" and posting."source_id" = transaction."source_id"
      and posting."transaction_id" = transaction."transaction_id"
      and posting."accounting_basis" = $4 and posting."currency_code" = $5
  ) posting on posting."line_count" > 0
  join lateral (
    select event.* from "erp_financials"."financial_lifecycle_events" event
    where event."tenant_id" = $1 and event."company_id" = $2
      and event."source_id" = transaction."source_id" and event."aggregate_type" = 'journal_entry'
      and event."aggregate_id" = transaction."transaction_id"
      and event."event_type" in ('journal_entry.posted', 'journal_entry.adjustment_posted')
    order by event."occurred_at", event."recorded_at", event."event_id" limit 1
  ) prepared on true
  left join lateral (
    select count(*)::integer as "link_count",
      count(*) filter (where link."link_type" = 'reversal')::integer as "reversal_count",
      count(*) filter (where link."link_type" = 'void')::integer as "void_count",
      count(*) filter (where link."link_type" = 'correction')::integer as "correction_count",
      count(*) filter (where link."link_type" = 'replacement')::integer as "replacement_count"
    from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = $1 and link."company_id" = $2 and link."source_id" = transaction."source_id"
      and link."original_transaction_id" = transaction."transaction_id"
  ) links on true
  left join lateral (
    select link."original_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = $1 and link."company_id" = $2 and link."source_id" = transaction."source_id"
      and link."related_transaction_id" = transaction."transaction_id"
    order by link."created_at", link."journal_entry_link_id" limit 1
  ) inbound on true
  where transaction."tenant_id" = $1 and transaction."status" = 'posted'
    and ($16::text is null or (transaction."source_id"=$6 and transaction."source_transaction_type"=$10 and transaction."source_transaction_id"=$16))
)
select *, "transaction_date"::text as "transaction_date" from journal
where ($6::text is null or "source_id" = $6)
  and ($7::text is null or "canonical_status" = $7)
  and ($8::date is null or "transaction_date" >= $8)
  and ($9::date is null or "transaction_date" <= $9)
  and ($10::text is null or "source_transaction_type" = $10)
  and ($11::text is null or "preparer_actor_ref" = $11)
  and ($12::text is null or strpos(lower(concat_ws(' ', "transaction_number", "memo", "journal_entry_id")), lower($12)) > 0)
  and ($13::date is null or ("transaction_date", "journal_entry_id") < ($13::date, $14::text))
order by journal."transaction_date" desc, "journal_entry_id" desc
limit $15`,
      [scope.tenantId, scope.companyId, scope.bookId, book.accountingBasis, book.currencyCode,
        filters.sourceId, filters.status, filters.periodStart, filters.periodEnd, filters.transactionType,
        filters.preparerRef, filters.search, page.date, page.id, page.limit + 1, filters.sourceTransactionId]
    );
    return toPage(result.rows.map(journalEntryFromRow), page.limit, pageKind, scope.bookId, (item) => ({
      date: item.transactionDate,
      id: item.journalEntryId
    }));
  });
}

async function getJournalEntry(scope: Scope, journalEntryId: string): Promise<JournalEntryDetail> {
  assertNonEmpty(journalEntryId, "journalEntryId");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const header = await client.query(
      `select transaction."transaction_id" as "journal_entry_id",
  coalesce(inbound."original_transaction_id", transaction."transaction_id") as "original_transaction_id",
  transaction."source_id", transaction."source_transaction_id", transaction."source_transaction_type",
  transaction."transaction_number", transaction."transaction_date", transaction."posted_at", transaction."memo",
  transaction."currency_code", posting."accounting_basis", posting."total_debit", posting."total_credit",
  posting."line_count", source."source_role", accounting_source."source_system",
  accounting_source."provider_environment", transaction."source_payload_ref",
  case when links."replacement_count" > 0 then 'replaced' when links."correction_count" > 0 then 'corrected'
    when links."void_count" > 0 then 'voided' when links."reversal_count" > 0 then 'reversed' else 'posted' end as "canonical_status",
  1 + links."link_count" as "version",
  prepared."event_id" as "preparer_event_id", prepared."event_type" as "preparer_event_type",
  prepared."actor_ref" as "preparer_actor_ref", prepared."approver_ref" as "preparer_approver_ref",
  prepared."request_id" as "preparer_request_id", prepared."correlation_id" as "preparer_correlation_id",
  prepared."reason_code" as "preparer_reason_code", prepared."reason_detail" as "preparer_reason_detail",
  prepared."occurred_at" as "preparer_occurred_at", prepared."recorded_at" as "preparer_recorded_at",
  prepared."payload_checksum" as "preparer_payload_checksum", prepared."prior_event_id" as "preparer_prior_event_id"
from "erp_financials"."transactions" transaction
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = transaction."source_id"
 and (source."effective_from" is null or source."effective_from" <= transaction."transaction_date")
 and (source."effective_through" is null or source."effective_through" >= transaction."transaction_date")
join "erp_financials"."accounting_sources" accounting_source
  on accounting_source."tenant_id" = transaction."tenant_id" and accounting_source."source_id" = transaction."source_id"
join lateral (
  select coalesce(sum("debit_amount"), 0) as "total_debit", coalesce(sum("credit_amount"), 0) as "total_credit",
    count(*)::integer as "line_count", min("accounting_basis") as "accounting_basis"
  from "erp_financials"."ledger_postings"
  where "tenant_id" = transaction."tenant_id" and "source_id" = transaction."source_id"
    and "transaction_id" = transaction."transaction_id" and "accounting_basis" = $4 and "currency_code" = $5
) posting on posting."line_count" > 0
join lateral (
  select event.* from "erp_financials"."financial_lifecycle_events" event
  where event."tenant_id" = $1 and event."company_id" = $2 and event."source_id" = transaction."source_id"
    and event."aggregate_type" = 'journal_entry' and event."aggregate_id" = transaction."transaction_id"
    and event."event_type" in ('journal_entry.posted', 'journal_entry.adjustment_posted')
  order by event."occurred_at", event."recorded_at", event."event_id" limit 1
) prepared on true
left join lateral (
  select count(*)::integer as "link_count",
    count(*) filter (where "link_type" = 'reversal')::integer as "reversal_count",
    count(*) filter (where "link_type" = 'void')::integer as "void_count",
    count(*) filter (where "link_type" = 'correction')::integer as "correction_count",
    count(*) filter (where "link_type" = 'replacement')::integer as "replacement_count"
  from "erp_financials"."journal_entry_links"
  where "tenant_id" = $1 and "company_id" = $2 and "source_id" = transaction."source_id"
    and "original_transaction_id" = transaction."transaction_id"
) links on true
left join lateral (
  select "original_transaction_id" from "erp_financials"."journal_entry_links"
  where "tenant_id" = $1 and "company_id" = $2 and "source_id" = transaction."source_id"
    and "related_transaction_id" = transaction."transaction_id"
  order by "created_at", "journal_entry_link_id" limit 1
) inbound on true
where transaction."tenant_id" = $1 and transaction."transaction_id" = $6 and transaction."status" = 'posted'`,
      [scope.tenantId, scope.companyId, scope.bookId, book.accountingBasis, book.currencyCode, journalEntryId]
    );
    const headerRow = header.rows[0];
    if (headerRow === undefined) {
      throw new ErpFinancialsError("missing_document", `Journal entry ${journalEntryId} does not exist in this book`, {
        details: { bookId: scope.bookId, journalEntryId }
      });
    }
    const item = journalEntryFromRow(headerRow);
    const linesResult = await client.query(
      `select line."transaction_line_id", posting."posting_id", posting."source_posting_id", line."line_number",
  account."account_id", account."source_account_id",
  coalesce(mapping."book_account_key", posting."source_id" || ':' || posting."account_id") as "book_account_key",
  account."account_number", account."name" as "account_name", account."classification",
  posting."party_id", posting."item_id", line."description", posting."debit_amount", posting."credit_amount",
  posting."net_amount", posting."dimension_refs"
from "erp_financials"."ledger_postings" posting
join "erp_financials"."transaction_lines" line
  on line."tenant_id" = posting."tenant_id" and line."source_id" = posting."source_id"
 and line."transaction_line_id" = posting."transaction_line_id"
join "erp_financials"."accounts" account
  on account."tenant_id" = posting."tenant_id" and account."source_id" = posting."source_id" and account."account_id" = posting."account_id"
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = posting."source_id" and mapping."account_id" = posting."account_id"
where posting."tenant_id" = $1 and posting."source_id" = $4 and posting."transaction_id" = $5
  and posting."accounting_basis" = $6 and posting."currency_code" = $7
order by line."line_number", line."transaction_line_id", posting."posting_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, item.sourceId, journalEntryId,
        book.accountingBasis, book.currencyCode]
    );
    const lines = linesResult.rows.map(journalEntryLineFromRow);
    assertBalancedJournalDetail(item, lines);
    const lifecycleResult = await client.query(
      `select * from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "aggregate_type" = 'journal_entry' and "aggregate_id" = $4
order by "occurred_at", "recorded_at", "event_id"`,
      [scope.tenantId, scope.companyId, item.sourceId, journalEntryId]
    );
    const linksResult = await client.query(
      `select link.*, event."event_id", event."event_type", event."actor_ref", event."approver_ref", event."request_id",
  event."correlation_id", event."reason_code", event."reason_detail", event."occurred_at", event."recorded_at",
  event."payload_checksum", event."prior_event_id"
from "erp_financials"."journal_entry_links" link
join "erp_financials"."financial_lifecycle_events" event
  on event."tenant_id" = link."tenant_id" and event."company_id" = link."company_id"
 and event."source_id" = link."source_id" and event."event_id" = link."lifecycle_event_id"
where link."tenant_id" = $1 and link."company_id" = $2 and link."source_id" = $3
  and (link."original_transaction_id" = $4 or link."related_transaction_id" = $4)
order by link."created_at", link."journal_entry_link_id"`,
      [scope.tenantId, scope.companyId, item.sourceId, journalEntryId]
    );
    return {
      ...item,
      lines,
      lifecycle: lifecycleResult.rows.map((row) => accountingLifecycleFromRow(row)),
      links: linksResult.rows.map(journalEntryLinkFromRow)
    };
  });
}

async function listFiscalPeriods(
  scope: Scope,
  input: PageRequest & { readonly sourceId: string; readonly status?: FiscalPeriodReadModel["status"]; readonly fiscalYear?: number }
): Promise<Page<FiscalPeriodReadModel>> {
  const filters = fiscalPeriodFilters(input);
  const pageKind = `fiscal-periods:${readFilterFingerprint(filters)}`;
  const page = pageInput(input, pageKind, scope.bookId);
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `${fiscalPeriodSelectSql()}
where period."tenant_id" = $1 and period."company_id" = $2 and period."source_id" = $4
  and ($5::text is null or period."status" = $5)
  and ($6::integer is null or period."fiscal_year" = $6)
  and ($7::date is null or (period."period_start", period."fiscal_period_id") < ($7::date, $8::text))
order by period."period_start" desc, period."fiscal_period_id" desc
limit $9`,
      [scope.tenantId, scope.companyId, scope.bookId, filters.sourceId, filters.status, filters.fiscalYear,
        page.date, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(fiscalPeriodFromRow), page.limit, pageKind, scope.bookId, (item) => ({
      date: item.periodStart,
      id: item.fiscalPeriodId
    }));
  });
}

async function getFiscalPeriod(scope: Scope, sourceId: string, fiscalPeriodId: string): Promise<FiscalPeriodReadModel> {
  assertReadFilterText(sourceId, "sourceId");
  assertReadFilterText(fiscalPeriodId, "fiscalPeriodId");
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `${fiscalPeriodSelectSql()}
where period."tenant_id" = $1 and period."company_id" = $2 and period."source_id" = $4
  and period."fiscal_period_id" = $5`,
      [scope.tenantId, scope.companyId, scope.bookId, sourceId, fiscalPeriodId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError("missing_document", `Fiscal period ${fiscalPeriodId} does not exist in this book/source`, {
        details: { bookId: scope.bookId, fiscalPeriodId, sourceId }
      });
    }
    return fiscalPeriodFromRow(row);
  });
}

async function getPostingLock(scope: Scope, sourceId: string): Promise<PostingLockReadModel> {
  assertReadFilterText(sourceId, "sourceId");
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `select source."source_id", controls."posting_lock_date"::text as "posting_lock_date", coalesce(controls."version", 0) as "version",
  event."event_id", event."event_type", event."actor_ref", event."approver_ref", event."request_id",
  event."correlation_id", event."reason_code", event."reason_detail", event."occurred_at", event."recorded_at",
  event."payload_checksum", event."prior_event_id"
from "erp_financials"."reporting_book_sources" source
left join "erp_financials"."accounting_book_controls" controls
  on controls."tenant_id" = source."tenant_id" and controls."company_id" = source."company_id"
 and controls."source_id" = source."source_id"
left join "erp_financials"."financial_lifecycle_events" event
  on event."tenant_id" = controls."tenant_id" and event."company_id" = controls."company_id"
 and event."source_id" = controls."source_id" and event."event_id" = controls."last_event_id"
where source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = $4`,
      [scope.tenantId, scope.companyId, scope.bookId, sourceId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError("scope_mismatch", `Accounting source ${sourceId} does not belong to this book`, {
        details: { bookId: scope.bookId, sourceId }
      });
    }
    const postingLockDate = optionalDate(row.posting_lock_date, "posting_lock_date");
    const lifecycle = optionalString(row.event_id) === undefined ? undefined : accountingLifecycleFromRow(row);
    return {
      sourceId: string(row.source_id, "source_id"),
      ...(postingLockDate === undefined ? {} : { postingLockDate }),
      version: integer(row.version, "version"),
      ...(lifecycle === undefined ? {} : { lifecycle })
    };
  });
}

function fiscalPeriodSelectSql(): string {
  return `select period.*, period."period_start"::text as "period_start", period."period_end"::text as "period_end", close_event."payload" as "close_payload",
  close_event."event_id" as "close_event_id_read", close_event."event_type" as "close_event_type",
  close_event."actor_ref" as "close_actor_ref", close_event."approver_ref" as "close_approver_ref",
  close_event."request_id" as "close_request_id", close_event."correlation_id" as "close_correlation_id",
  close_event."reason_code" as "close_reason_code", close_event."reason_detail" as "close_reason_detail",
  close_event."occurred_at" as "close_occurred_at", close_event."recorded_at" as "close_recorded_at",
  close_event."payload_checksum" as "close_payload_checksum", close_event."prior_event_id" as "close_prior_event_id",
  reopen_event."event_id" as "reopen_event_id_read", reopen_event."event_type" as "reopen_event_type",
  reopen_event."actor_ref" as "reopen_actor_ref", reopen_event."approver_ref" as "reopen_approver_ref",
  reopen_event."request_id" as "reopen_request_id", reopen_event."correlation_id" as "reopen_correlation_id",
  reopen_event."reason_code" as "reopen_reason_code", reopen_event."reason_detail" as "reopen_reason_detail",
  reopen_event."occurred_at" as "reopen_occurred_at", reopen_event."recorded_at" as "reopen_recorded_at",
  reopen_event."payload_checksum" as "reopen_payload_checksum", reopen_event."prior_event_id" as "reopen_prior_event_id",
  latest."event_id" as "latest_event_id", latest."event_type" as "latest_event_type",
  latest."actor_ref" as "latest_actor_ref", latest."approver_ref" as "latest_approver_ref",
  latest."request_id" as "latest_request_id", latest."correlation_id" as "latest_correlation_id",
  latest."reason_code" as "latest_reason_code", latest."reason_detail" as "latest_reason_detail",
  latest."occurred_at" as "latest_occurred_at", latest."recorded_at" as "latest_recorded_at",
  latest."payload_checksum" as "latest_payload_checksum", latest."prior_event_id" as "latest_prior_event_id"
from "erp_financials"."fiscal_periods" period
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = period."source_id"
left join "erp_financials"."financial_lifecycle_events" close_event
  on close_event."tenant_id" = period."tenant_id" and close_event."company_id" = period."company_id"
 and close_event."source_id" = period."source_id" and close_event."event_id" = period."close_event_id"
left join "erp_financials"."financial_lifecycle_events" reopen_event
  on reopen_event."tenant_id" = period."tenant_id" and reopen_event."company_id" = period."company_id"
 and reopen_event."source_id" = period."source_id" and reopen_event."event_id" = period."reopen_event_id"
join lateral (
  select event.* from "erp_financials"."financial_lifecycle_events" event
  where event."tenant_id" = period."tenant_id" and event."company_id" = period."company_id"
    and event."source_id" = period."source_id" and event."aggregate_type" = 'fiscal_period'
    and event."aggregate_id" = period."fiscal_period_id"
  order by event."occurred_at" desc, event."recorded_at" desc, event."event_id" desc limit 1
) latest on true`;
}

async function latestInvoiceNumberSequence(scope: Scope): Promise<number | null> {
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `with invoice_number_digits as (
  select substring(draft."document_number" from 5) as "digits"
  from "erp_financials"."invoice_drafts" draft
  where draft."tenant_id" = $1 and draft."company_id" = $2 and draft."book_id" = $3
    and draft."document_number" collate "C" ~* '^INV-[0-9]+$'
  union all
  select substring(document."document_number" from 5)
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" = 'invoice'
    and document."document_number" collate "C" ~* '^INV-[0-9]+$'
), normalized_invoice_numbers as (
  select coalesce(nullif(ltrim("digits", '0'), ''), '0') as "digits"
  from invoice_number_digits
), longest_invoice_numbers as (
  select "digits"
  from normalized_invoice_numbers
  where length("digits") = (select max(length("digits")) from normalized_invoice_numbers)
)
select max("digits" collate "C") as "latest_sequence"
from longest_invoice_numbers`,
      [scope.tenantId, scope.companyId, scope.bookId]
    );
    const value = result.rows[0]?.latest_sequence;
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
      throw new ErpFinancialsError("invalid_input", "The latest invoice number sequence is invalid");
    }
    const sequence = BigInt(value);
    if (sequence > 2147483647n) {
      throw new ErpFinancialsError("invalid_input", "The invoice number sequence has exceeded its supported range", {
        details: { maximumSequence: 2147483647 }
      });
    }
    return Number(sequence);
  });
}

const MAX_PAYMENT_REFERENCE_IDS = 1000;

function paymentReferenceIds(values: readonly string[], field: string): readonly string[] {
  const candidates: readonly unknown[] = values;
  if (!Array.isArray(candidates)) throw new ErpFinancialsError("invalid_input", `${field} must be an array`);
  if (candidates.length > MAX_PAYMENT_REFERENCE_IDS) {
    throw new ErpFinancialsError("invalid_input", `${field} must not contain more than 1000 entries`, {
      details: { maximumBatchSize: MAX_PAYMENT_REFERENCE_IDS }
    });
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ErpFinancialsError("invalid_input", `${field} must contain non-empty strings`, { details: { index } });
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

async function findCustomerPaymentHistoryPartyIds(
  scope: Scope,
  partyIds: readonly string[]
): Promise<readonly string[]> {
  const requested = paymentReferenceIds(partyIds, "partyIds");
  if (requested.length === 0) return [];
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `select distinct document."party_id"
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
where document."tenant_id" = $1 and document."company_id" = $2
  and document."document_type" = 'customer_payment'
  and document."party_id" = any($4::text[])
order by document."party_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, requested]
    );
    return result.rows.map((row) => string(row.party_id, "party_id"));
  });
}

async function getOpenInvoicesByIds(
  scope: Scope,
  invoiceIds: readonly string[]
): Promise<readonly OpenInvoiceReference[]> {
  const requested = paymentReferenceIds(invoiceIds, "invoiceIds");
  if (requested.length === 0) return [];
  return scope.database.transaction(async (client) => {
    await resolveBook(client, scope);
    const result = await client.query(
      `with requested as (
  select requested."invoice_id", requested."requested_order"
  from unnest($4::text[]) with ordinality requested("invoice_id", "requested_order")
)
select document."subledger_document_id" as "invoice_id", document."document_number",
  document."due_date"::text as "due_date", document."open_amount", document."currency_code", document."version"
from requested
join "erp_financials"."subledger_documents" document
  on document."tenant_id" = $1 and document."company_id" = $2
 and document."subledger_document_id" = requested."invoice_id"
 and document."document_type" = 'invoice'
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
left join "erp_financials"."invoice_voids" void
  on void."tenant_id" = document."tenant_id" and void."company_id" = document."company_id"
 and void."book_id" = $3 and void."source_id" = document."source_id"
 and void."invoice_document_id" = document."subledger_document_id"
where document."open_amount" > 0 and document."status" <> 'settled'
  and void."invoice_void_id" is null
order by document."due_date", document."subledger_document_id" collate "C", requested."requested_order"`,
      [scope.tenantId, scope.companyId, scope.bookId, requested]
    );
    return result.rows.map((row): OpenInvoiceReference => {
      const documentNumber = optionalString(row.document_number);
      return {
        invoiceId: string(row.invoice_id, "invoice_id"),
        ...(documentNumber === undefined ? {} : { documentNumber }),
        dueDate: date(row.due_date, "due_date"),
        openAmount: decimal(row.open_amount, "open_amount"),
        currencyCode: string(row.currency_code, "currency_code"),
        version: integer(row.version, "version")
      };
    });
  });
}

// Register totals and coarse filters do not depend on names or delivery state.
// Keep presentation lookups outside that growing financial scan.
function invoiceRowsSql(presentation: boolean, identityBatch = false): string {
  return `with invoice_rows as (
  select draft."invoice_draft_id" as "invoice_id", draft."source_id", 'draft'::text as "provenance",
    draft."customer_id" as "party_id", ${presentation ? 'party."display_name"' : 'null::text'} as "party_name", draft."document_number",
    draft."document_date", null::date as "recognition_date", draft."due_date", draft."currency_code",
    coalesce(lines."original_amount", 0)::numeric as "original_amount",
    coalesce(lines."original_amount", 0)::numeric as "open_amount", draft."status", draft."version"
  from "erp_financials"."invoice_drafts" draft
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = draft."tenant_id" and source."company_id" = draft."company_id"
   and source."book_id" = draft."book_id" and source."source_id" = draft."source_id"
   and (source."effective_from" is null or source."effective_from" <= draft."document_date")
   and (source."effective_through" is null or source."effective_through" >= draft."document_date")
  ${presentation ? `left join "erp_financials"."parties" party
    on party."tenant_id" = draft."tenant_id" and party."source_id" = draft."source_id" and party."party_id" = draft."customer_id"` : ""}
  left join lateral (
    select sum(line."line_amount") as "original_amount" from "erp_financials"."invoice_draft_lines" line
    where line."tenant_id" = draft."tenant_id" and line."company_id" = draft."company_id"
      and line."book_id" = draft."book_id" and line."invoice_draft_id" = draft."invoice_draft_id"
  ) lines on true
  where draft."tenant_id" = $1 and draft."company_id" = $2 and draft."book_id" = $3 and draft."status" <> 'issued'
    and ${identityBatch ? 'draft."invoice_draft_id" = any($6::text[]) and draft."customer_id" = $7' : '($9::text is null or draft."invoice_draft_id" = $9)'}
  union all
  select document."subledger_document_id", document."source_id", 'posted'::text, document."party_id", ${presentation ? 'party."display_name"' : 'null::text'},
    document."document_number", document."document_date", document."recognition_date", document."due_date", document."currency_code",
    document."original_amount", document."open_amount",
    case
      when void."invoice_void_id" is not null then 'voided'
      when document."status" = 'settled' or document."open_amount" = 0 then 'paid'
      when document."due_date" < $4::date then 'overdue'
      when document."open_amount" < document."original_amount" then 'partial'
      ${presentation ? `when delivery."delivery_status" in ('sent', 'delivered') then 'sent'` : ""}
      else 'open'
    end, document."version"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  ${presentation ? `left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id" and party."party_id" = document."party_id"` : ""}
  left join "erp_financials"."invoice_voids" void
    on void."tenant_id" = document."tenant_id" and void."company_id" = document."company_id" and void."book_id" = $3
   and void."source_id" = document."source_id" and void."invoice_document_id" = document."subledger_document_id"
  ${presentation ? `left join lateral (
    select event."delivery_status" from "erp_financials"."subledger_document_delivery_events" event
    where event."tenant_id" = document."tenant_id" and event."company_id" = document."company_id"
      and event."source_id" = document."source_id" and event."subledger_document_id" = document."subledger_document_id"
    order by event."occurred_at" desc, event."delivery_event_id" desc limit 1
  ) delivery on true` : ""}
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'invoice'
    and ${identityBatch ? 'document."subledger_document_id" = any($6::text[]) and document."party_id" = $7' : '($9::text is null or document."subledger_document_id" = $9)'}
)`;
}

const INVOICE_LIST_ROWS_SQL = invoiceRowsSql(true);
const INVOICE_REGISTER_ROWS_SQL = invoiceRowsSql(false);

async function listInvoices(
  scope: Scope,
  input: PageRequest & { readonly status?: InvoiceListStatus; readonly asOfDate?: IsoDate; readonly invoiceId?: string }
): Promise<Page<InvoiceListItem>> {
  const page = pageInput(input, "invoices", scope.bookId);
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `${INVOICE_LIST_ROWS_SQL}
select *, "document_date"::text as "document_date", "recognition_date"::text as "recognition_date", "due_date"::text as "due_date" from invoice_rows
where "currency_code" = $5 and ($6::text is null or "status" = $6)
  and ($7::date is null or ("document_date", "invoice_id") < ($7::date, $8::text))
order by invoice_rows."document_date" desc, "invoice_id" desc
limit $10`,
      [scope.tenantId, scope.companyId, scope.bookId, asOfDate, book.currencyCode, input.status, page.date, page.id, input.invoiceId, page.limit + 1]
    );
    return toPage(result.rows.map(invoiceFromRow), page.limit, "invoices", scope.bookId, (item) => ({
      date: item.documentDate,
      id: item.invoiceId
    }));
  });
}

const INVOICE_SUMMARY_SETTLEMENT_JOINS = `left join erp_financials.invoice_voids v on v.tenant_id=$1 and v.company_id=$2 and v.book_id=$3 and v.source_id=p.source_id and v.invoice_document_id=p.invoice_id
left join lateral (
  select sum(applied_amount) filter(where application_type='customer_payment_to_invoice') cash_applied_amount,
    sum(applied_amount) filter(where application_type='credit_to_invoice' and subledger_application_id is distinct from v.application_id) credit_applied_amount,
    sum(applied_amount) filter(where application_type='write_off_to_invoice') write_off_applied_amount,
    sum(applied_amount) filter(where subledger_application_id=v.application_id) cancellation_amount
  from erp_financials.subledger_applications a where p.provenance='posted' and a.tenant_id=$1 and a.company_id=$2
    and a.source_id=p.source_id and a.target_document_id=p.invoice_id and a.currency_code=p.currency_code and a.status='applied'
) a on true`;

async function getInvoiceSummariesByIds(scope: Scope, request: { readonly invoiceIds: readonly string[]; readonly customerId: string; readonly asOfDate?: IsoDate }): Promise<readonly InvoiceRegisterItem[]> {
  const input=structuredClone(request),asOfDate=input.asOfDate??today();
  assertDate(asOfDate,"asOfDate");assertNonEmpty(input.customerId,"customerId");
  if(!Array.isArray(input.invoiceIds)||input.invoiceIds.length>200||input.invoiceIds.some(id=>typeof id!=="string"||!id.trim())||new Set(input.invoiceIds).size!==input.invoiceIds.length)throw new ErpFinancialsError("invalid_input","Invoice summaries require at most200 unique nonempty IDs");
  if(!input.invoiceIds.length)return [];
  return scope.database.transaction(async client=>{
    const book=await resolveBook(client,scope);
    const result=await client.query(`${invoiceRowsSql(true,true)}, summary_rows as (
select p.*,p.document_date::text document_date,p.recognition_date::text recognition_date,p.due_date::text due_date,
  coalesce(a.cash_applied_amount,0)::text cash_applied_amount,coalesce(a.credit_applied_amount,0)::text credit_applied_amount,
  coalesce(a.write_off_applied_amount,0)::text write_off_applied_amount,coalesce(a.cancellation_amount,0)::text cancellation_amount
from invoice_rows p ${INVOICE_SUMMARY_SETTLEMENT_JOINS}
where p.currency_code=$5
) select p.*,b.current_book from (
  select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status) current_book
  from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3
) b left join summary_rows p on true order by array_position($6::text[],p.invoice_id)`,
      [scope.tenantId,scope.companyId,scope.bookId,asOfDate,book.currencyCode,input.invoiceIds,input.customerId]);
    const currentBook=requiredRow(result.rows[0],"invoice summary book").current_book;
    if(!isRecord(currentBook)||currentBook.status!=="active"||currentBook.currency!==book.currencyCode||currentBook.basis!==book.accountingBasis)throw new ErpFinancialsError("optimistic_concurrency_conflict","Reporting book changed during invoice summary read; reload");
    return result.rows.filter(row=>row.invoice_id!==null).map(row=>{const invoice=invoiceFromRow(row);return {...invoice,
      registerStatus:(["open","sent","partial"].includes(invoice.status)?"open":invoice.status) as InvoiceRegisterStatus,settlement:invoiceSettlementFromRow(row)};});
  });
}

async function getInvoiceRegister(scope: Scope, request: InvoiceRegisterRequest): Promise<InvoiceRegisterPage> {
  const input = structuredClone(request), asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  if (input.customerId !== undefined) assertNonEmpty(input.customerId, "customerId");
  if (input.status !== undefined && !["draft","open","overdue","paid","voided","active","receivable"].includes(input.status)) throw new ErpFinancialsError("invalid_input", "Unsupported invoice register status");
  const kind = `invoice-register:${createHash("sha256").update(JSON.stringify([scope.tenantId,scope.companyId,scope.bookId,asOfDate,input.customerId??null,input.status??null])).digest("hex")}`;
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 8192 || input.asOfDate === undefined)) throw new ErpFinancialsError("invalid_input", "Invoice register continuation requires the original asOfDate and bounded cursor");
  const page = pageInput(input,kind,scope.bookId);
  let expectedRevision: string | undefined;
  if (input.cursor !== undefined) {
    const cursor = JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")) as Record<string,unknown>;
    if (typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.revision)) throw new ErpFinancialsError("invalid_input", "Invoice register cursor requires a revision");
    expectedRevision = cursor.revision;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client,scope);
    const result = await client.query(`${INVOICE_REGISTER_ROWS_SQL}, register_rows as not materialized (
  select *,case when status in ('open','sent','partial') then 'open' else status end register_status
  from invoice_rows where currency_code=$5 and ($11::text is null or party_id=$11)
), summary as (
  select count(*)::text count_all,count(*) filter(where register_status='draft')::text count_draft,
    count(*) filter(where register_status='open')::text count_open,count(*) filter(where register_status='overdue')::text count_overdue,
    count(*) filter(where register_status='paid')::text count_paid,count(*) filter(where register_status='voided')::text count_voided,
    coalesce(sum(open_amount) filter(where register_status in ('open','overdue')),0)::text outstanding_amount,
    coalesce(sum(open_amount) filter(where register_status='overdue'),0)::text overdue_amount,
    coalesce(sum(original_amount) filter(where register_status='draft'),0)::text draft_amount,
    coalesce(round(avg(greatest(0,$4::date-coalesce(recognition_date,document_date))) filter(where register_status in ('open','overdue'))),0)::text average_open_age_days
  from register_rows
), page_rows as materialized (
  select * from register_rows where ($6::text is null or register_status=$6
      or ($6='active' and register_status<>'voided') or ($6='receivable' and register_status not in ('draft','voided')))
    and ($7::date is null or (document_date,invoice_id)<($7::date,$8::text))
  order by document_date desc,invoice_id desc limit $10
), scope_revision as (
  select encode(sha256(convert_to(jsonb_build_array(
    (select to_jsonb(b) from erp_financials.reporting_books b where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3),
    (select jsonb_agg(to_jsonb(bs) order by bs.source_id) from erp_financials.reporting_book_sources bs where bs.tenant_id=$1 and bs.company_id=$2 and bs.book_id=$3),
    (select coalesce(sum(r.revision),0)::text from erp_financials.accounting_source_revisions r
      join erp_financials.reporting_book_sources bs on bs.tenant_id=r.tenant_id and bs.source_id=r.source_id and bs.company_id=$2 and bs.book_id=$3 where r.tenant_id=$1)
  )::text,'UTF8')),'hex') revision
)
select p.*,p.document_date::text document_date,p.recognition_date::text recognition_date,p.due_date::text due_date,s.*,
  coalesce(d.memo,t.memo) memo,item_party."display_name" item_party_name,
  case when p.status='open' and item_delivery.delivery_status in ('sent','delivered') then 'sent' else p.status end item_status,
  coalesce(a.cash_applied_amount,0)::text cash_applied_amount,coalesce(a.credit_applied_amount,0)::text credit_applied_amount,
  coalesce(a.write_off_applied_amount,0)::text write_off_applied_amount,coalesce(a.cancellation_amount,0)::text cancellation_amount,
  scope_revision.revision,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status)
    from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book
from summary s cross join scope_revision left join page_rows p on true
left join erp_financials.parties item_party on item_party.tenant_id=$1 and item_party.source_id=p.source_id and item_party.party_id=p.party_id
left join lateral (
  select event.delivery_status from erp_financials.subledger_document_delivery_events event
  where p.provenance='posted' and p.status='open' and event.tenant_id=$1 and event.company_id=$2
    and event.source_id=p.source_id and event.subledger_document_id=p.invoice_id
  order by event.occurred_at desc,event.delivery_event_id desc limit 1
) item_delivery on true
left join erp_financials.invoice_drafts d on p.provenance='draft' and d.tenant_id=$1 and d.company_id=$2 and d.book_id=$3 and d.invoice_draft_id=p.invoice_id
left join erp_financials.subledger_documents sd on p.provenance='posted' and sd.tenant_id=$1 and sd.company_id=$2 and sd.source_id=p.source_id and sd.subledger_document_id=p.invoice_id
left join erp_financials.transactions t on t.tenant_id=sd.tenant_id and t.source_id=sd.source_id and t.transaction_id=sd.transaction_id
${INVOICE_SUMMARY_SETTLEMENT_JOINS} order by p.document_date desc,p.invoice_id desc`,
      [scope.tenantId,scope.companyId,scope.bookId,asOfDate,book.currencyCode,input.status,page.date,page.id,null,page.limit+1,input.customerId]);
    const head = requiredRow(result.rows[0],"invoice register summary"), currentBook = head.current_book;
    if (!isRecord(currentBook) || currentBook.status !== "active" || currentBook.currency !== book.currencyCode || currentBook.basis !== book.accountingBasis) throw new ErpFinancialsError("optimistic_concurrency_conflict","Reporting book changed during invoice register read; reload");
    const revision = string(head.revision,"revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict","Invoice register changed; reload from the first page");
    const count = (key: string): string => { const value = string(head[`count_${key}`],key); if (!/^(0|[1-9]\d*)$/u.test(value)) throw new ErpFinancialsError("invalid_input","Invalid invoice register count"); return value; };
    const summary: InvoiceRegisterSummary = { counts:{all:count("all"),draft:count("draft"),open:count("open"),overdue:count("overdue"),paid:count("paid"),voided:count("voided")},
      outstandingAmount:money(head.outstanding_amount,"outstanding_amount"),overdueAmount:money(head.overdue_amount,"overdue_amount"),draftAmount:money(head.draft_amount,"draft_amount"),averageOpenAgeDays:string(head.average_open_age_days,"average_open_age_days") };
    if (!/^(0|[1-9]\d*)$/u.test(summary.averageOpenAgeDays)) throw new ErpFinancialsError("invalid_input","Invalid average invoice age");
    const candidates = result.rows.filter(row => row.invoice_id !== null), items = candidates.slice(0,page.limit).map(row => ({
      ...invoiceFromRow({...row,status:row.item_status,party_name:row.item_party_name}), registerStatus:string(row.register_status,"register_status") as InvoiceRegisterStatus,
      settlement:invoiceSettlementFromRow(row), ...(optionalString(row.memo) === undefined ? {} : {memo:string(row.memo,"memo")}) }));
    const last = items.at(-1);
    return {basis:"current",asOfDate,currencyCode:book.currencyCode,revision,summary,items,
      ...(candidates.length>page.limit && last ? {nextCursor:Buffer.from(JSON.stringify({v:1,kind,bookId:scope.bookId,date:last.documentDate,id:last.invoiceId,revision}),"utf8").toString("base64url")} : {})};
  });
}

const MAX_INVOICE_DETAIL_BATCH_SIZE = 100;

// Only included by the explicit receipt-page API. Ordinary batched invoice
// reads retain their existing work and response contract. Financial values,
// provenance, page and revision share the invoice SQL statement's snapshot.
const INVOICE_RECEIPT_PAGE_CTES = `, receipt_evidence as (
  select a.subledger_application_id application_id,a.application_date::text application_date,a.applied_amount::text amount,
    a.source_document_id payment_id,a.source_id,a.currency_code,p.party_id customer_id,p.document_date::text payment_date,
    p.created_at payment_created_at,p.idempotency_key payment_idempotency_key,p.transaction_id payment_transaction_id,
    t.memo payment_memo,e.event_id lifecycle_event_id,e.actor_ref,e.approver_ref,e.request_id,e.reason_code,
    (p.subledger_document_id is null or p.document_type<>'customer_payment' or p.status='voided'
      or p.party_id is distinct from i.party_id or p.currency_code<>a.currency_code or t.transaction_id is null
      or not exists(select 1 from erp_financials.reporting_book_sources bs
        where bs.tenant_id=$1 and bs.company_id=$2 and bs.book_id=$3 and bs.source_id=p.source_id
          and (bs.effective_from is null or bs.effective_from<=p.document_date)
          and (bs.effective_through is null or bs.effective_through>=p.document_date))) invalid
  from erp_financials.subledger_applications a
  join (select distinct invoice_id,source_id,party_id from invoice_detail_rows where provenance='posted') i
    on i.invoice_id=a.target_document_id and i.source_id=a.source_id
  left join erp_financials.subledger_documents p on p.tenant_id=a.tenant_id and p.company_id=a.company_id
    and p.source_id=a.source_id and p.subledger_document_id=a.source_document_id
  left join erp_financials.transactions t on t.tenant_id=p.tenant_id and t.source_id=p.source_id and t.transaction_id=p.transaction_id
  left join erp_financials.financial_lifecycle_events e on e.tenant_id=p.tenant_id and e.company_id=p.company_id
    and e.source_id=p.source_id and e.event_id=p.lifecycle_event_id
  where a.tenant_id=$1 and a.company_id=$2 and a.currency_code=$5
    and a.status='applied' and a.application_type='customer_payment_to_invoice'
), receipt_totals as (
  select count(*)::integer count,coalesce(sum(amount::numeric),0) amount,coalesce(bool_or(invalid or amount::numeric<=0),false) invalid,
    max(payment_date) latest_receipt_date,max(application_date) latest_application_date
  from receipt_evidence
), receipt_page as (
  select * from receipt_evidence where ($7::date is null or (application_date::date,application_id)<($7::date,$8::text))
  order by application_date desc,application_id desc limit $9
), receipt_revision as (
  select encode(sha256(convert_to(jsonb_build_array(
    (select jsonb_agg(to_jsonb(d) order by requested_order,line_number nulls last,line_id nulls last) from invoice_detail_rows d),
    (select to_jsonb(b) from erp_financials.reporting_books b where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3),
    (select jsonb_agg(to_jsonb(bs) order by bs.source_id) from erp_financials.reporting_book_sources bs where bs.tenant_id=$1 and bs.company_id=$2 and bs.book_id=$3),
    (select coalesce(sum(r.revision),0)::text from erp_financials.accounting_source_revisions r
      where r.tenant_id=$1 and r.source_id in(select distinct source_id from invoice_detail_rows))
  )::text,'UTF8')),'hex') revision
)`;

function invoiceReceiptFromRow(row: Record<string, unknown>): InvoiceReceiptApplication {
  const paymentMemo = optionalString(row.payment_memo);
  return { applicationId: string(row.application_id,"application_id"), applicationDate: date(row.application_date,"application_date"),
    amount: money(row.amount,"amount"), paymentId:string(row.payment_id,"payment_id"), sourceId:string(row.source_id,"source_id"),
    customerId:string(row.customer_id,"customer_id"),currencyCode:string(row.currency_code,"currency_code"),
    paymentDate:date(row.payment_date,"payment_date"),paymentCreatedAt:isoDateTime(row.payment_created_at,"payment_created_at"),
    paymentIdempotencyKey:string(row.payment_idempotency_key,"payment_idempotency_key"),paymentTransactionId:string(row.payment_transaction_id,"payment_transaction_id"),
    ...(paymentMemo===undefined?{}:{paymentMemo}),
    ...(optionalString(row.actor_ref)===undefined?{}:{paymentCreationLifecycle:lifecycleFromRow(row)}) };
}

async function getInvoiceReceiptPage(scope: Scope, invoiceId: string, request: InvoiceReceiptPageRequest): Promise<InvoiceReceiptPage> {
  assertNonEmpty(invoiceId,"invoiceId");
  const input=structuredClone(request),asOfDate=input.asOfDate??today();
  assertDate(asOfDate,"asOfDate");
  const kind=`invoice-receipts:${createHash("sha256").update(JSON.stringify([scope.tenantId,scope.companyId,scope.bookId,invoiceId,asOfDate])).digest("hex")}`;
  if(input.cursor!==undefined&&(typeof input.cursor!=="string"||input.cursor.length>8192||input.asOfDate===undefined)) {
    throw new ErpFinancialsError("invalid_input","Invoice receipt continuation requires a bounded cursor and the original asOfDate");
  }
  const page=pageInput(input,kind,scope.bookId);
  let expectedRevision:string|undefined;
  if(input.cursor!==undefined){
    const cursor=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")) as Record<string,unknown>;
    if(typeof cursor.revision!=="string"||!/^[a-f0-9]{64}$/u.test(cursor.revision))throw new ErpFinancialsError("invalid_input","Invoice receipt cursor requires a revision");
    expectedRevision=cursor.revision;
  }
  const result=await getInvoicesByIds(scope,[invoiceId],asOfDate,{...page,kind,...(expectedRevision===undefined?{}:{expectedRevision})});
  if(!result.receiptPage)throw new ErpFinancialsError("missing_document",`Invoice ${invoiceId} does not exist in reporting book ${scope.bookId}`);
  return result.receiptPage;
}

async function getInvoicesByIds(
  scope: Scope,
  invoiceIds: readonly string[],
  asOfDate = today(),
  receiptRead?: DecodedPage & { readonly kind: string; readonly expectedRevision?: string }
): Promise<InvoiceDetailsByIdResult & { readonly receiptPage?: InvoiceReceiptPage }> {
  const candidates: readonly unknown[] = invoiceIds;
  if (!Array.isArray(candidates)) throw new ErpFinancialsError("invalid_input", "invoiceIds must be an array");
  if (candidates.length > MAX_INVOICE_DETAIL_BATCH_SIZE) {
    throw new ErpFinancialsError("invalid_input", "Invoice detail batch size must not exceed 100", {
      details: { maximumBatchSize: MAX_INVOICE_DETAIL_BATCH_SIZE }
    });
  }
  const seen = new Set<string>();
  const validatedInvoiceIds: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const invoiceId = invoiceIds[index];
    if (typeof invoiceId !== "string" || invoiceId.trim().length === 0) {
      throw new ErpFinancialsError("invalid_input", "Invoice detail batch IDs must be non-empty strings", {
        details: { index }
      });
    }
    if (seen.has(invoiceId)) {
      throw new ErpFinancialsError("invalid_input", "Invoice detail batch IDs must not contain duplicates", {
        details: { invoiceId, index }
      });
    }
    seen.add(invoiceId);
    validatedInvoiceIds.push(invoiceId);
  }
  if (validatedInvoiceIds.length === 0) return { orderedInvoiceIds: [], byInvoiceId: {} };
  assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with requested as (
  select requested."invoice_id", requested."requested_order"
  from unnest($6::text[]) with ordinality requested("invoice_id", "requested_order")
), invoice_detail_rows as (
  select requested."requested_order", draft."invoice_draft_id" as "invoice_id", draft."source_id",
    'draft'::text as "provenance", draft."customer_id" as "party_id", party."display_name" as "party_name",
    draft."document_number", draft."document_date", null::date as "recognition_date", draft."due_date", draft."currency_code",
    coalesce(amounts."original_amount", 0)::numeric as "original_amount",
    coalesce(amounts."original_amount", 0)::numeric as "open_amount", draft."status", draft."version", draft."memo",
    draft."created_at", draft."updated_at", draft."idempotency_key", null::text as "transaction_id",
    creation."event_id" as "lifecycle_event_id", creation."actor_ref", creation."approver_ref", creation."request_id", creation."reason_code",
    line."invoice_draft_line_id" as "line_id", line."line_number", line."account_id", line."item_id",
    line."description", line."quantity", line."unit_amount", line."unit_cost", line."discount_amount",
    line."tax_code", line."tax_amount", line."tax_account_id", line."discount_account_id", line."service_period_start", line."service_period_end",
    line."dimension_refs", line."line_amount", line_account."account_number",
    0::numeric as cash_applied_amount,0::numeric as credit_applied_amount,
    0::numeric as write_off_applied_amount,0::numeric as cancellation_amount
  from requested
  join "erp_financials"."invoice_drafts" draft
    on draft."tenant_id" = $1 and draft."company_id" = $2 and draft."book_id" = $3
   and draft."invoice_draft_id" = requested."invoice_id" and draft."status" <> 'issued'
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = draft."tenant_id" and source."company_id" = draft."company_id"
   and source."book_id" = draft."book_id" and source."source_id" = draft."source_id"
   and (source."effective_from" is null or source."effective_from" <= draft."document_date")
   and (source."effective_through" is null or source."effective_through" >= draft."document_date")
  left join "erp_financials"."financial_lifecycle_events" creation
    on creation."tenant_id" = draft."tenant_id" and creation."company_id" = draft."company_id"
   and creation."source_id" = draft."source_id" and creation."aggregate_type" = 'invoice_draft'
   and creation."aggregate_id" = draft."invoice_draft_id" and creation."event_type" = 'invoice.draft_created'
   and creation."idempotency_key" = 'invoice-draft:' || draft."idempotency_key" || ':created'
  left join "erp_financials"."parties" party
    on party."tenant_id" = draft."tenant_id" and party."source_id" = draft."source_id"
   and party."party_id" = draft."customer_id"
  left join lateral (
    select sum(amount_line."line_amount") as "original_amount"
    from "erp_financials"."invoice_draft_lines" amount_line
    where amount_line."tenant_id" = draft."tenant_id" and amount_line."company_id" = draft."company_id"
      and amount_line."book_id" = draft."book_id" and amount_line."invoice_draft_id" = draft."invoice_draft_id"
  ) amounts on true
  left join "erp_financials"."invoice_draft_lines" line
    on line."tenant_id" = draft."tenant_id" and line."company_id" = draft."company_id"
   and line."book_id" = draft."book_id" and line."invoice_draft_id" = draft."invoice_draft_id"
  left join "erp_financials"."accounts" line_account
    on line_account."tenant_id" = draft."tenant_id" and line_account."source_id" = draft."source_id"
   and line_account."account_id" = line."account_id"
  where draft."currency_code" = $5
  union all
  select requested."requested_order", document."subledger_document_id", document."source_id", 'posted'::text,
    document."party_id", party."display_name", document."document_number", document."document_date", document."recognition_date",
    document."due_date", document."currency_code", document."original_amount", document."open_amount",
    case
      when void."invoice_void_id" is not null then 'voided'
      when document."status" = 'settled' or document."open_amount" = 0 then 'paid'
      when document."due_date" < $4::date then 'overdue'
      when document."open_amount" < document."original_amount" then 'partial'
      when delivery."delivery_status" in ('sent', 'delivered') then 'sent'
      else 'open'
    end, document."version", transaction."memo", document."created_at", document."updated_at", document."idempotency_key", document."transaction_id",
    creation."event_id", creation."actor_ref", creation."approver_ref", creation."request_id", creation."reason_code",
    line."subledger_document_line_id", line."line_number",
    line."account_id", line."item_id", line."description", line."quantity", line."unit_amount", line."unit_cost",
    line."discount_amount", line."tax_code", line."tax_amount", line."tax_account_id", line."discount_account_id", line."service_period_start",
    line."service_period_end", line."dimension_refs", line."line_amount", line_account."account_number",
    settlement.cash_applied_amount,settlement.credit_applied_amount,
    settlement.write_off_applied_amount,settlement.cancellation_amount
  from requested
  join "erp_financials"."subledger_documents" document
    on document."tenant_id" = $1 and document."company_id" = $2
   and document."subledger_document_id" = requested."invoice_id" and document."document_type" = 'invoice'
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  join "erp_financials"."transactions" transaction
    on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
   and transaction."transaction_id" = document."transaction_id"
  left join "erp_financials"."financial_lifecycle_events" creation
    on creation."tenant_id" = document."tenant_id" and creation."company_id" = document."company_id"
   and creation."source_id" = document."source_id" and creation."event_id" = document."lifecycle_event_id"
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id"
  left join "erp_financials"."invoice_voids" void
    on void."tenant_id" = document."tenant_id" and void."company_id" = document."company_id"
   and void."book_id" = $3 and void."source_id" = document."source_id"
   and void."invoice_document_id" = document."subledger_document_id"
  left join lateral (
    select coalesce(sum(a.applied_amount) filter(where a.application_type='customer_payment_to_invoice'),0) as cash_applied_amount,
      coalesce(sum(a.applied_amount) filter(where a.application_type='credit_to_invoice' and a.subledger_application_id is distinct from void.application_id),0) as credit_applied_amount,
      coalesce(sum(a.applied_amount) filter(where a.application_type='write_off_to_invoice'),0) as write_off_applied_amount,
      coalesce(sum(a.applied_amount) filter(where a.subledger_application_id=void.application_id),0) as cancellation_amount
    from erp_financials.subledger_applications a
    where a.tenant_id=document.tenant_id and a.company_id=document.company_id and a.source_id=document.source_id
      and a.target_document_id=document.subledger_document_id and a.currency_code=document.currency_code and a.status='applied'
  ) settlement on true
  left join lateral (
    select event."delivery_status"
    from "erp_financials"."subledger_document_delivery_events" event
    where event."tenant_id" = document."tenant_id" and event."company_id" = document."company_id"
      and event."source_id" = document."source_id"
      and event."subledger_document_id" = document."subledger_document_id"
    order by event."occurred_at" desc, event."delivery_event_id" desc limit 1
  ) delivery on true
  left join "erp_financials"."subledger_document_lines" line
    on line."tenant_id" = document."tenant_id" and line."company_id" = document."company_id"
   and line."source_id" = document."source_id"
   and line."subledger_document_id" = document."subledger_document_id"
  left join "erp_financials"."accounts" line_account
    on line_account."tenant_id" = document."tenant_id" and line_account."source_id" = document."source_id"
   and line_account."account_id" = line."account_id"
  where document."currency_code" = $5
 )
${receiptRead ? INVOICE_RECEIPT_PAGE_CTES : ""}
select *, "document_date"::text as "document_date", "recognition_date"::text as "recognition_date", "due_date"::text as "due_date", "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end"
 , (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status)
    from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book
${receiptRead ? `, (select revision from receipt_revision) receipt_revision,
  (select count from receipt_totals) receipt_count, (select amount::text from receipt_totals) receipt_amount,
  (select invalid from receipt_totals) receipt_invalid,
  (select latest_receipt_date from receipt_totals) latest_receipt_date, (select latest_application_date from receipt_totals) latest_application_date,
  case when row_number() over(order by requested_order,line_number nulls last,line_id nulls last)=1
    then (select coalesce(jsonb_agg(to_jsonb(p) order by application_date desc,application_id desc),'[]'::jsonb) from receipt_page p)
    else null end as receipt_rows` : ""}
from invoice_detail_rows
order by "requested_order", "line_number" nulls last, "line_id" nulls last`,
      [scope.tenantId, scope.companyId, scope.bookId, asOfDate, book.currencyCode, validatedInvoiceIds,
        ...(receiptRead ? [receiptRead.date, receiptRead.id, receiptRead.limit + 1] : [])]
    );
    const currentBook = result.rows[0]?.current_book;
    if (result.rows.length && (!isRecord(currentBook) || currentBook.status !== "active" || currentBook.currency !== book.currencyCode || currentBook.basis !== book.accountingBasis)) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during invoice read; reload");
    }
    const details = new Map<string, InvoiceDetail & { lines: CommercialDocumentLineReadModel[] }>();
    for (const row of result.rows) {
      const invoiceId = string(row.invoice_id, "invoice_id");
      let detail = details.get(invoiceId);
      if (detail === undefined) {
        const memo = optionalString(row.memo);
        detail = {
          ...invoiceFromRow(row),
          settlement: invoiceSettlementFromRow(row),
          createdAt: isoDateTime(row.created_at, "created_at"),
          updatedAt: isoDateTime(row.updated_at, "updated_at"),
          idempotencyKey: string(row.idempotency_key, "idempotency_key"),
          ...(optionalString(row.transaction_id) === undefined ? {} : { transactionId: string(row.transaction_id, "transaction_id") }),
          ...(optionalString(row.lifecycle_event_id) === undefined ? {} : { creationLifecycle: lifecycleFromRow(row) }),
          ...(memo === undefined ? {} : { memo }),
          lines: []
        };
        details.set(invoiceId, detail);
      }
      if (row.line_id !== null && row.line_id !== undefined) detail.lines.push(commercialLineFromRow(row));
    }
    const orderedInvoiceIds = validatedInvoiceIds.filter((invoiceId) => details.has(invoiceId));
    const byInvoiceId = Object.fromEntries(orderedInvoiceIds.flatMap((invoiceId) => {
      const detail = details.get(invoiceId);
      return detail === undefined ? [] : [[invoiceId, detail]];
    }));
    if (!receiptRead || !orderedInvoiceIds.length) return { orderedInvoiceIds, byInvoiceId };
    const row = requiredRow(result.rows[0], "invoice receipt page"), invoice = byInvoiceId[orderedInvoiceIds[0] ?? ""];
    if (!invoice) throw new ErpFinancialsError("missing_document", "Invoice does not exist in the reporting book");
    const revision = string(row.receipt_revision, "receipt_revision");
    if (receiptRead.expectedRevision !== undefined && revision !== receiptRead.expectedRevision) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Invoice accounting changed during pagination; reload the invoice");
    }
    const totalAppliedAmount = money(row.receipt_amount, "receipt_amount");
    if (row.receipt_invalid === true || totalAppliedAmount !== invoice.settlement?.cashAppliedAmount) {
      throw new ErpFinancialsError("reconciliation_conflict", "Invoice receipt evidence does not reconcile to its cash settlement");
    }
    const raw = optionalJson(row.receipt_rows);
    if (!Array.isArray(raw)) throw new Error("Stored invoice receipts must be an array");
    const receipts = toPage(raw.map(value => invoiceReceiptFromRow(jsonObject(value, "invoice receipt"))),
      receiptRead.limit, receiptRead.kind, scope.bookId, item => ({ date: item.applicationDate, id: item.applicationId }));
    const nextCursor = receipts.nextCursor === undefined ? undefined : Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(receipts.nextCursor, "base64url").toString("utf8")), revision
    }), "utf8").toString("base64url");
    return { orderedInvoiceIds, byInvoiceId, receiptPage: { basis: "current", asOfDate, invoice, revision,
      totalApplicationCount: integer(row.receipt_count, "receipt_count"), totalAppliedAmount,
      ...(row.latest_receipt_date == null ? {} : { latestReceiptDate: date(row.latest_receipt_date,"latest_receipt_date") }),
      ...(row.latest_application_date == null ? {} : { latestApplicationDate: date(row.latest_application_date,"latest_application_date") }),
      items: receipts.items, ...(nextCursor === undefined ? {} : { nextCursor }) } };
  });
}

function invoiceSettlementFromRow(row: Record<string, unknown>): InvoiceSettlementSummary {
  const cashAppliedAmount=money(row.cash_applied_amount,"cash_applied_amount");
  const creditAppliedAmount=money(row.credit_applied_amount,"credit_applied_amount");
  const writeOffAppliedAmount=money(row.write_off_applied_amount,"write_off_applied_amount");
  const cancellationAmount=money(row.cancellation_amount,"cancellation_amount");
  const reduction=moneyMinor(money(row.original_amount,"original_amount"))-moneyMinor(money(row.open_amount,"open_amount"));
  const classified=[cashAppliedAmount,creditAppliedAmount,writeOffAppliedAmount,cancellationAmount].map(moneyMinor);
  const unclassified=reduction-classified.reduce((total,amount)=>total+amount,0n);
  if(reduction<0n||unclassified<0n||classified.some(amount=>amount<0n)) {
    throw new ErpFinancialsError("reconciliation_conflict","Invoice settlement evidence does not reconcile to its outstanding balance");
  }
  return {basis:"current",cashAppliedAmount,creditAppliedAmount,writeOffAppliedAmount,cancellationAmount,
    unclassifiedAmount:minorMoney(unclassified),balanceReductionAmount:minorMoney(reduction)};
}

async function getInvoice(scope: Scope, invoiceId: string, asOfDate = today()): Promise<InvoiceDetail> {
  assertNonEmpty(invoiceId, "invoiceId");
  // Header, balance, lifecycle status and lines must come from one SQL snapshot.
  // Separate list/header/line reads can mix revisions under READ COMMITTED.
  const result = await getInvoicesByIds(scope, [invoiceId], asOfDate);
  const invoice = result.byInvoiceId[invoiceId];
  if (invoice === undefined) {
    throw new ErpFinancialsError("missing_document", `Invoice ${invoiceId} does not exist in reporting book ${scope.bookId}`, {
      details: { bookId: scope.bookId, invoiceId }
    });
  }
  return invoice;
}

async function listInvoiceAudit(scope: Scope, invoiceId: string, input: PageRequest): Promise<Page<InvoiceAuditEvent>> {
  assertNonEmpty(invoiceId, "invoiceId");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "invoice-audit", scope.bookId);
  const cursorScope = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, invoiceId])).digest("hex");
  let afterTime: string | undefined;
  let afterId: string | undefined;
  if (input.cursor !== undefined) {
    if (input.cursor.length > 4096) throw new ErpFinancialsError("invalid_input", "Invoice audit cursor is too large");
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new ErpFinancialsError("invalid_input", "Invoice audit cursor is invalid"); }
    if (!isRecord(cursor) || cursor.kind !== "invoice-audit" || cursor.v !== 1 || cursor.scope !== cursorScope ||
        typeof cursor.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(cursor.recordedAt) ||
        Number.isNaN(Date.parse(cursor.recordedAt)) || typeof cursor.id !== "string" || !cursor.id) {
      throw new ErpFinancialsError("invalid_input", "Invoice audit cursor does not belong to this scope");
    }
    afterTime = cursor.recordedAt; afterId = cursor.id;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with anchor as materialized (
  select document."subledger_document_id" as "invoice_id", document."source_id", document."transaction_id", null::text as "draft_id"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id"=document."tenant_id" and source."company_id"=document."company_id"
   and source."source_id"=document."source_id" and source."book_id"=$3
   and (source."effective_from" is null or source."effective_from"<=coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through">=coalesce(document."recognition_date",document."document_date"))
  where document."tenant_id"=$1 and document."company_id"=$2 and document."subledger_document_id"=$4
    and document."document_type"='invoice' and document."currency_code"=$5
  union all
  select draft."issued_document_id",draft."source_id",document."transaction_id",draft."invoice_draft_id"
  from "erp_financials"."invoice_drafts" draft
  left join "erp_financials"."subledger_documents" document
    on document."tenant_id"=draft."tenant_id" and document."company_id"=draft."company_id"
   and document."source_id"=draft."source_id" and document."subledger_document_id"=draft."issued_document_id"
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id"=draft."tenant_id" and source."company_id"=draft."company_id"
   and source."source_id"=draft."source_id" and source."book_id"=$3
   and (source."effective_from" is null or source."effective_from"<=coalesce(coalesce(document."recognition_date",document."document_date"),draft."document_date"))
   and (source."effective_through" is null or source."effective_through">=coalesce(coalesce(document."recognition_date",document."document_date"),draft."document_date"))
  where draft."tenant_id"=$1 and draft."company_id"=$2 and draft."book_id"=$3
    and draft."invoice_draft_id"=$4 and draft."currency_code"=$5
), related as (
  select "source_id",'subledger_document'::text as "aggregate_type","invoice_id" as "aggregate_id" from anchor
  union select "source_id",'subledger_document',"transaction_id" from anchor
  union select "source_id",'invoice',"invoice_id" from anchor
  union select "source_id",'invoice_draft',"draft_id" from anchor
  union select draft."source_id",'invoice_draft',draft."invoice_draft_id"
    from anchor join "erp_financials"."invoice_drafts" draft
      on draft."tenant_id"=$1 and draft."company_id"=$2 and draft."source_id"=anchor."source_id"
     and draft."issued_document_id"=anchor."invoice_id"
  union select application."source_id",'subledger_application',application."subledger_application_id"
    from anchor join "erp_financials"."subledger_applications" application
      on application."tenant_id"=$1 and application."company_id"=$2 and application."source_id"=anchor."source_id"
     and application."target_document_id"=anchor."invoice_id"
), evidence as (
  select event.* from related
  join "erp_financials"."financial_lifecycle_events" event
    on event."tenant_id"=$1 and event."company_id"=$2 and event."source_id"=related."source_id"
   and event."aggregate_type"=related."aggregate_type" and event."aggregate_id"=related."aggregate_id"
  where ($6::timestamptz is null or (event."recorded_at",event."event_id")<($6::timestamptz,$7::text))
  order by event."recorded_at" desc,event."event_id" desc limit $8
)
select (select count(*)::integer from anchor) as "anchor_count",evidence.*,to_char(evidence."recorded_at" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursor_recorded_at"
from anchor left join evidence on true order by evidence."recorded_at" desc,evidence."event_id" desc`,
      [scope.tenantId, scope.companyId, scope.bookId, invoiceId, book.currencyCode, afterTime, afterId, limit + 1]);
    if (!result.rows.length) throw new ErpFinancialsError("missing_document", `Invoice ${invoiceId} does not exist in reporting book ${scope.bookId}`);
    if (result.rows[0]?.anchor_count !== 1) throw new ErpFinancialsError("invalid_input", "Invoice identifier is ambiguous across document kinds");
    const rows = result.rows.filter(row => row.event_id !== null).slice(0, limit);
    const items = rows.map(row => ({ ...accountingLifecycleFromRow({ ...row, recorded_at: row.cursor_recorded_at }),
      sourceId: string(row.source_id, "source_id"), aggregateType: string(row.aggregate_type, "aggregate_type"),
      aggregateId: string(row.aggregate_id, "aggregate_id"), payload: jsonObject(row.payload, "payload") }));
    const last = rows.at(-1);
    if (result.rows.length <= limit || !last) return { items };
    return { items, nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "invoice-audit", scope: cursorScope,
      recordedAt: string(last.cursor_recorded_at, "cursor_recorded_at"), id: string(last.event_id, "event_id") }), "utf8").toString("base64url") };
  });
}

async function listVendorBillAudit(scope: Scope, billId: string, input: PageRequest): Promise<Page<VendorBillAuditEvent>> {
  assertNonEmpty(billId, "billId");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "vendor-bill-audit", scope.bookId);
  const cursorScope = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, billId])).digest("hex");
  let afterTime: string | undefined;
  let afterId: string | undefined;
  if (input.cursor !== undefined) {
    if (input.cursor.length > 4096) throw new ErpFinancialsError("invalid_input", "Vendor bill audit cursor is too large");
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new ErpFinancialsError("invalid_input", "Vendor bill audit cursor is invalid"); }
    if (!isRecord(cursor) || cursor.kind !== "vendor-bill-audit" || cursor.v !== 1 || cursor.scope !== cursorScope ||
        typeof cursor.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(cursor.recordedAt) ||
        Number.isNaN(Date.parse(cursor.recordedAt)) || typeof cursor.id !== "string" || !cursor.id) {
      throw new ErpFinancialsError("invalid_input", "Vendor bill audit cursor does not belong to this scope");
    }
    afterTime = cursor.recordedAt; afterId = cursor.id;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with anchor as materialized (
  select document."subledger_document_id" as "bill_id", document."source_id", document."transaction_id"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id"=document."tenant_id" and source."company_id"=document."company_id"
   and source."source_id"=document."source_id" and source."book_id"=$3
   and (source."effective_from" is null or source."effective_from"<=coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through">=coalesce(document."recognition_date",document."document_date"))
  where document."tenant_id"=$1 and document."company_id"=$2 and document."subledger_document_id"=$4
    and document."document_type"='vendor_bill' and document."currency_code"=$5
), applications as materialized (
  select application."source_id",application."subledger_application_id",application."source_document_id"
  from anchor join "erp_financials"."subledger_applications" application
    on application."tenant_id"=$1 and application."company_id"=$2 and application."source_id"=anchor."source_id"
   and application."target_document_id"=anchor."bill_id"
), instructions as materialized (
  select payment."source_id",payment."bill_payment_id",payment."subledger_document_id"
  from anchor join "erp_financials"."bill_payment_disbursements" payment
    on payment."tenant_id"=$1 and payment."company_id"=$2 and payment."source_id"=anchor."source_id"
   and payment."allocations" @> jsonb_build_array(jsonb_build_object('billId',anchor."bill_id"))
), payments as (
  select "source_id","source_document_id" as "document_id" from applications
  union select "source_id","subledger_document_id" from instructions
), related as (
  select "source_id",'subledger_document'::text as "aggregate_type","bill_id" as "aggregate_id" from anchor
  union select "source_id",'subledger_document',"transaction_id" from anchor
  union select "source_id",'subledger_application',"subledger_application_id" from applications
  union select "source_id",'bill_payment',"bill_payment_id" from instructions
  union select "source_id",'subledger_document',"document_id" from payments
  union select payment."source_id",'subledger_document',payment."transaction_id"
    from payments join "erp_financials"."subledger_documents" payment
      on payment."tenant_id"=$1 and payment."company_id"=$2 and payment."source_id"=payments."source_id"
     and payment."subledger_document_id"=payments."document_id"
), evidence as (
  select event.* from related
  join "erp_financials"."financial_lifecycle_events" event
    on event."tenant_id"=$1 and event."company_id"=$2 and event."source_id"=related."source_id"
   and event."aggregate_type"=related."aggregate_type" and event."aggregate_id"=related."aggregate_id"
  where ($6::timestamptz is null or (event."recorded_at",event."event_id")<($6::timestamptz,$7::text))
  order by event."recorded_at" desc,event."event_id" desc limit $8
)
select (select count(*)::integer from anchor) as "anchor_count",evidence.*,to_char(evidence."recorded_at" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursor_recorded_at"
from anchor left join evidence on true order by evidence."recorded_at" desc,evidence."event_id" desc`,
      [scope.tenantId, scope.companyId, scope.bookId, billId, book.currencyCode, afterTime, afterId, limit + 1]);
    if (!result.rows.length) throw new ErpFinancialsError("missing_document", `Vendor bill ${billId} does not exist in reporting book ${scope.bookId}`);
    if (result.rows[0]?.anchor_count !== 1) throw new ErpFinancialsError("invalid_input", "Vendor bill identifier is ambiguous across document kinds");
    const rows = result.rows.filter(row => row.event_id !== null).slice(0, limit);
    const items = rows.map(row => ({ ...accountingLifecycleFromRow({ ...row, recorded_at: row.cursor_recorded_at }),
      sourceId: string(row.source_id, "source_id"), aggregateType: string(row.aggregate_type, "aggregate_type"),
      aggregateId: string(row.aggregate_id, "aggregate_id"), payload: jsonObject(row.payload, "payload") }));
    const last = rows.at(-1);
    if (result.rows.length <= limit || !last) return { items };
    return { items, nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "vendor-bill-audit", scope: cursorScope,
      recordedAt: string(last.cursor_recorded_at, "cursor_recorded_at"), id: string(last.event_id, "event_id") }), "utf8").toString("base64url") };
  });
}

async function listInvoiceDeliveries(
  scope: Scope,
  invoiceId: string,
  input: PageRequest
): Promise<Page<InvoiceDeliveryEvent>> {
  assertNonEmpty(invoiceId, "invoiceId");
  const invoice = await getInvoice(scope, invoiceId);
  if (invoice.sourceProvenance === "draft") return { items: [] };
  const page = pageInput(input, `invoice-deliveries:${invoiceId}`, scope.bookId);
  return scope.database.transaction(async (client) => {
    const result = await client.query(
      `select event."delivery_event_id", event."subledger_document_id" as "invoice_id", event."delivery_status",
  event."channel", event."recipient_ref", event."occurred_at", event."lifecycle_event_id"
from "erp_financials"."subledger_document_delivery_events" event
join "erp_financials"."subledger_documents" document
  on document."tenant_id" = event."tenant_id" and document."company_id" = event."company_id"
 and document."source_id" = event."source_id" and document."subledger_document_id" = event."subledger_document_id"
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
where event."tenant_id" = $1 and event."company_id" = $2 and event."subledger_document_id" = $4
  and document."document_type" = 'invoice'
  and ($5::date is null or (event."occurred_at"::date, event."delivery_event_id") < ($5::date, $6::text))
order by event."occurred_at" desc, event."delivery_event_id" desc
limit $7`,
      [scope.tenantId, scope.companyId, scope.bookId, invoiceId, page.date, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(invoiceDeliveryFromRow), page.limit, `invoice-deliveries:${invoiceId}`, scope.bookId, (item) => ({
      date: item.occurredAt.slice(0, 10),
      id: item.deliveryEventId
    }));
  });
}

async function getInvoiceSummary(
  scope: Scope,
  input: { readonly asOfDate?: IsoDate }
): Promise<InvoiceSummary> {
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with posted as (
  select document."subledger_document_id", document."open_amount", document."due_date",
    not exists (
      select 1 from "erp_financials"."invoice_voids" void
      where void."tenant_id" = document."tenant_id" and void."company_id" = document."company_id"
        and void."book_id" = $3 and void."source_id" = document."source_id"
        and void."invoice_document_id" = document."subledger_document_id"
    ) as "not_voided"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'invoice'
    and document."currency_code" = $4 and coalesce(document."recognition_date",document."document_date") <= $5::date
), drafts as (
  select draft."invoice_draft_id", coalesce(sum(line."line_amount"), 0) as "amount"
  from "erp_financials"."invoice_drafts" draft
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = draft."tenant_id" and source."company_id" = draft."company_id"
   and source."book_id" = draft."book_id" and source."source_id" = draft."source_id"
   and (source."effective_from" is null or source."effective_from" <= draft."document_date")
   and (source."effective_through" is null or source."effective_through" >= draft."document_date")
  left join "erp_financials"."invoice_draft_lines" line
    on line."tenant_id" = draft."tenant_id" and line."company_id" = draft."company_id"
   and line."book_id" = draft."book_id" and line."source_id" = draft."source_id"
   and line."invoice_draft_id" = draft."invoice_draft_id"
  where draft."tenant_id" = $1 and draft."company_id" = $2 and draft."book_id" = $3
    and draft."status" = 'draft' and draft."currency_code" = $4 and draft."document_date" <= $5::date
  group by draft."invoice_draft_id"
), collected as (
  select coalesce(sum(application."applied_amount"), 0) as "amount"
  from "erp_financials"."subledger_applications" application
  join posted on posted."subledger_document_id" = application."target_document_id" and posted."not_voided"
  where application."tenant_id" = $1 and application."company_id" = $2
    and application."application_type" = 'customer_payment_to_invoice' and application."status" = 'applied'
    and application."application_date" <= $5::date
)
select
  coalesce(sum("open_amount") filter (where "not_voided" and "open_amount" > 0), 0) as "outstanding_amount",
  count(*) filter (where "not_voided" and "open_amount" > 0)::integer as "outstanding_count",
  coalesce(sum("open_amount") filter (where "not_voided" and "open_amount" > 0 and "due_date" < $5::date), 0) as "overdue_amount",
  count(*) filter (where "not_voided" and "open_amount" > 0 and "due_date" < $5::date)::integer as "overdue_count",
  coalesce((select sum("amount") from drafts), 0) as "draft_amount",
  (select count(*)::integer from drafts) as "draft_count",
  (select "amount" from collected) as "collected_amount",
  count(*) filter (where "not_voided" and "open_amount" = 0)::integer as "settled_count"
from posted`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, asOfDate]
    );
    const row = requiredRow(result.rows[0], "invoice summary");
    return {
      asOfDate,
      currencyCode: book.currencyCode,
      outstandingAmount: money(row.outstanding_amount, "outstanding_amount"),
      outstandingInvoiceCount: integer(row.outstanding_count, "outstanding_count"),
      overdueAmount: money(row.overdue_amount, "overdue_amount"),
      overdueInvoiceCount: integer(row.overdue_count, "overdue_count"),
      unsentDraftAmount: money(row.draft_amount, "draft_amount"),
      unsentDraftCount: integer(row.draft_count, "draft_count"),
      collectedAmount: money(row.collected_amount, "collected_amount"),
      settledInvoiceCount: integer(row.settled_count, "settled_count")
    };
  });
}

async function getCustomerStatement(
  scope: Scope,
  request: CustomerStatementRequest
): Promise<CustomerStatement> {
  const input = structuredClone(request);
  assertNonEmpty(input.customerId, "customerId");
  assertDate(input.asOfDate, "asOfDate");
  if (input.includeApplications !== undefined && typeof input.includeApplications !== "boolean") throw new ErpFinancialsError("invalid_input", "includeApplications must be boolean");
  const applicationsIncluded = input.includeApplications !== false;
  const cursorKind = `customer-statement:${createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.customerId, input.asOfDate, applicationsIncluded]))
    .digest("hex")
    .slice(0, 20)}`;
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 8192)) throw new ErpFinancialsError("invalid_input", "Customer statement cursor is invalid");
  const page = pageInput(input, cursorKind, scope.bookId);
  let expectedRevision: string | undefined;
  if (input.cursor !== undefined) {
    const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.revision)) throw new ErpFinancialsError("invalid_input", "Customer statement cursor needs a current report revision");
    expectedRevision = cursor.revision;
  }
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with scoped_invoices as (
  select document."subledger_document_id" as "invoice_id", document."source_id", document."transaction_id",
    document."party_id" as "customer_id", party."display_name" as "customer_name", document."document_number",
    document."document_date", document."recognition_date", document."due_date", document."currency_code", document."original_amount",
    source_definition."source_system", source_definition."provider_environment",
    transaction."source_transaction_id", transaction."source_transaction_type"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" book_source
    on book_source."tenant_id" = document."tenant_id" and book_source."company_id" = document."company_id"
   and book_source."book_id" = $3 and book_source."source_id" = document."source_id"
   and (book_source."effective_from" is null or book_source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (book_source."effective_through" is null or book_source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  join "erp_financials"."accounting_sources" source_definition
    on source_definition."tenant_id" = document."tenant_id" and source_definition."source_id" = document."source_id"
  join "erp_financials"."transactions" transaction
    on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
   and transaction."transaction_id" = document."transaction_id"
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id" and party."party_type" = 'customer'
  left join "erp_financials"."invoice_voids" invoice_void
    on invoice_void."tenant_id" = document."tenant_id" and invoice_void."company_id" = document."company_id"
   and invoice_void."book_id" = $3 and invoice_void."source_id" = document."source_id"
   and invoice_void."invoice_document_id" = document."subledger_document_id"
  left join "erp_financials"."subledger_applications" void_application
    on void_application."tenant_id" = invoice_void."tenant_id" and void_application."company_id" = invoice_void."company_id"
   and void_application."source_id" = invoice_void."source_id" and void_application."subledger_application_id" = invoice_void."application_id"
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'invoice'
    and document."party_id" = $4 and document."currency_code" = $5 and coalesce(document."recognition_date",document."document_date") <= $6::date
    and (invoice_void."invoice_void_id" is null or void_application."application_date" > $6::date)
), active_applications as (
  select application."target_document_id" as "invoice_id", application."subledger_application_id" as "application_id",
    application."application_type", application."application_date", application."applied_amount",
    application."currency_code", application."source_document_id", source_document."document_type" as "source_document_type",
    source_document."document_number" as "source_document_number", source_document."document_date" as "source_document_date",
    source_document."transaction_id" as "source_transaction_id", source_transaction."source_transaction_id" as "source_external_transaction_id",
    source_transaction."source_transaction_type", application_source."source_system",
    application_source."provider_environment", application."applied_event_id", application."ended_event_id"
  from "erp_financials"."subledger_applications" application
  join scoped_invoices invoice
    on invoice."source_id" = application."source_id" and invoice."invoice_id" = application."target_document_id"
  join "erp_financials"."financial_lifecycle_events" applied_event
    on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
   and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
  left join "erp_financials"."financial_lifecycle_events" ended_event
    on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
   and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
  join "erp_financials"."subledger_documents" source_document
    on source_document."tenant_id" = application."tenant_id" and source_document."company_id" = application."company_id"
   and source_document."source_id" = application."source_id"
   and source_document."subledger_document_id" = application."source_document_id"
  join "erp_financials"."transactions" source_transaction
    on source_transaction."tenant_id" = source_document."tenant_id" and source_transaction."source_id" = source_document."source_id"
   and source_transaction."transaction_id" = source_document."transaction_id"
  join "erp_financials"."accounting_sources" application_source
    on application_source."tenant_id" = application."tenant_id" and application_source."source_id" = application."source_id"
  join "erp_financials"."reporting_book_sources" application_book_source
    on application_book_source."tenant_id" = application."tenant_id"
   and application_book_source."company_id" = application."company_id"
   and application_book_source."book_id" = $3 and application_book_source."source_id" = application."source_id"
   and (application_book_source."effective_from" is null
     or (application_book_source."effective_from" <= coalesce(source_document."recognition_date",source_document."document_date")
       and application_book_source."effective_from" <= application."application_date"))
   and (application_book_source."effective_through" is null
     or (application_book_source."effective_through" >= coalesce(source_document."recognition_date",source_document."document_date")
       and application_book_source."effective_through" >= application."application_date"))
  where application."tenant_id" = $1 and application."company_id" = $2
    and application."application_type" in ('customer_payment_to_invoice', 'credit_to_invoice', 'write_off_to_invoice')
    and application."currency_code" = $5 and application."application_date" <= $6::date
    and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) < ($6::date + interval '1 day')
    and (ended_event."event_id" is null or coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) >= ($6::date + interval '1 day'))
), application_amounts as (
  select "invoice_id", sum("applied_amount") as "applied_amount",
    coalesce(sum("applied_amount") filter(where "application_type"='customer_payment_to_invoice'),0) as "cash_applied_amount",
    coalesce(sum("applied_amount") filter(where "application_type"='credit_to_invoice'),0) as "credit_applied_amount",
    coalesce(sum("applied_amount") filter(where "application_type"='write_off_to_invoice'),0) as "write_off_applied_amount"
  from active_applications
  group by "invoice_id"
), invoice_balances as (
  select invoice.*, coalesce(amounts."applied_amount", 0)::numeric as "applied_amount",
    (invoice."original_amount" - coalesce(amounts."applied_amount", 0))::numeric as "open_balance",
    coalesce(amounts."cash_applied_amount",0) as "cash_applied_amount",
    coalesce(amounts."credit_applied_amount",0) as "credit_applied_amount",
    coalesce(amounts."write_off_applied_amount",0) as "write_off_applied_amount"
  from scoped_invoices invoice
  left join application_amounts amounts on amounts."invoice_id" = invoice."invoice_id"
), statement_totals as (
  select count(*)::integer as "total_invoice_count", coalesce(sum("original_amount"), 0) as "total_invoiced_amount",
    coalesce(sum("applied_amount"), 0) as "total_applied_amount", coalesce(sum("open_balance"), 0) as "total_outstanding_amount",
    coalesce(sum("cash_applied_amount"),0) as "total_cash_applied_amount",
    coalesce(sum("credit_applied_amount"),0) as "total_credit_applied_amount",
    coalesce(sum("write_off_applied_amount"),0) as "total_write_off_applied_amount",
    coalesce(bool_or("open_balance"<0 or "applied_amount"<0),false) as "invalid_balance"
  from invoice_balances
), page_rows as (
  select * from invoice_balances
  where ($7::date is null or ("document_date", "invoice_id") > ($7::date, $8::text))
  order by "document_date", "invoice_id"
  limit $9
), application_evidence as (
  select application."invoice_id",
    jsonb_agg(jsonb_build_object(
      'applicationId', application."application_id", 'applicationType', application."application_type",
      'applicationDate', application."application_date", 'amount', application."applied_amount"::text,
      'currencyCode', application."currency_code", 'sourceDocumentId', application."source_document_id",
      'sourceDocumentType', application."source_document_type", 'sourceDocumentNumber', application."source_document_number",
      'sourceDocumentDate', application."source_document_date", 'sourceId', invoice."source_id",
      'sourceSystem', application."source_system", 'providerEnvironment', application."provider_environment",
      'transactionId', application."source_transaction_id",
      'sourceTransactionId', application."source_external_transaction_id",
      'sourceTransactionType', application."source_transaction_type",
      'appliedLifecycleEventId', application."applied_event_id",
      'endedLifecycleEventId', application."ended_event_id"
    ) order by application."application_date", application."application_id") as "applications"
  from active_applications application
  join page_rows invoice on invoice."invoice_id" = application."invoice_id"
  where $10::boolean
  group by application."invoice_id"
)
, report_revision as (
  select encode(sha256(convert_to(jsonb_build_array(
    (select to_jsonb(b) from erp_financials.reporting_books b where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3),
    (select jsonb_agg(to_jsonb(bs) order by bs.source_id) from erp_financials.reporting_book_sources bs where bs.tenant_id=$1 and bs.company_id=$2 and bs.book_id=$3),
    (select jsonb_agg(to_jsonb(src) order by src.source_id) from erp_financials.accounting_sources src join erp_financials.reporting_book_sources bs on bs.tenant_id=src.tenant_id and bs.source_id=src.source_id and bs.company_id=$2 and bs.book_id=$3 where src.tenant_id=$1),
    (select jsonb_agg(to_jsonb(p) order by p.source_id,p.party_id) from erp_financials.parties p join erp_financials.reporting_book_sources bs on bs.tenant_id=p.tenant_id and bs.source_id=p.source_id and bs.company_id=$2 and bs.book_id=$3 where p.tenant_id=$1 and p.party_type='customer' and p.party_id=$4),
    (select coalesce(sum(r.revision),0)::text from erp_financials.accounting_source_revisions r join erp_financials.reporting_book_sources bs on bs.tenant_id=r.tenant_id and bs.source_id=r.source_id and bs.company_id=$2 and bs.book_id=$3 where r.tenant_id=$1 and r.effective_date<=$6::date)
  )::text,'UTF8')),'hex') as revision
)
 , customer_balance as (
  ${receivableAgingDocumentsSql("$6", "$5", "'invoice'", "array['customer_payment','credit_memo']", "$4")}
  select coalesce(sum(signed_open_amount) filter(where document_type='invoice'),0)::text balance_invoice,
    coalesce(-sum(signed_open_amount) filter(where document_type='customer_payment'),0)::text balance_cash,
    coalesce(-sum(signed_open_amount) filter(where document_type='credit_memo'),0)::text balance_credit,
    coalesce(sum(signed_open_amount),0)::text balance_net
  from aging_documents
), customer_identity as (
  select count(*)>0 customer_exists,min(p.display_name) statement_customer_name
  from erp_financials.parties p
  join erp_financials.reporting_book_sources bs on bs.tenant_id=p.tenant_id and bs.source_id=p.source_id
    and bs.company_id=$2 and bs.book_id=$3
  where p.tenant_id=$1 and p.party_type='customer' and p.party_id=$4
)
select customer_balance.*,customer_identity.*,page_rows.*, page_rows."document_date"::text as "document_date", page_rows."recognition_date"::text as "recognition_date", coalesce(application_evidence."applications", '[]'::jsonb) as "applications", statement_totals.*,report_revision.revision,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status)
    from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book
from statement_totals cross join report_revision cross join customer_balance cross join customer_identity
left join page_rows on true
left join application_evidence on application_evidence."invoice_id" = page_rows."invoice_id"
order by page_rows."document_date", page_rows."invoice_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, input.customerId, book.currencyCode, input.asOfDate,
        page.date, page.id, page.limit + 1, applicationsIncluded]
    );
    const totalsRow = requiredRow(result.rows[0], "customer statement totals");
    if (!isRecord(totalsRow.current_book) || totalsRow.current_book.status !== "active" || totalsRow.current_book.currency !== book.currencyCode || totalsRow.current_book.basis !== book.accountingBasis) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during statement read; reload");
    }
    const revision = string(totalsRow.revision, "revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Accounting changed during statement pagination; reload from the first page");
    if (totalsRow.invalid_balance === true) throw new ErpFinancialsError("reconciliation_conflict", "Historical statement applications exceed an invoice balance");
    const totals = customerStatementTotalsFromRow(totalsRow, "total_");
    const values = result.rows
      .filter((row) => row.invoice_id !== null && row.invoice_id !== undefined)
      .map(customerStatementRowFromRow);
    const paged = toPage(values, page.limit, cursorKind, scope.bookId, (item) => ({
      date: item.documentDate,
      id: item.invoiceId
    }));
    return {
      customerId: input.customerId,
      customerExists: totalsRow.customer_exists === true,
      ...(typeof totalsRow.statement_customer_name === "string" ? {customerName: totalsRow.statement_customer_name} : {}),
      balance: {
        invoiceOutstandingAmount: money(totalsRow.balance_invoice,"balance_invoice"),
        unappliedCashAmount: money(totalsRow.balance_cash,"balance_cash"),
        unappliedCreditAmount: money(totalsRow.balance_credit,"balance_credit"),
        netReceivableAmount: money(totalsRow.balance_net,"balance_net")
      },
      asOfDate: input.asOfDate,
      applicationsIncluded,
      revision,
      currencyCode: book.currencyCode,
      items: paged.items,
      ...(paged.nextCursor === undefined ? {} : { nextCursor: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(paged.nextCursor, "base64url").toString("utf8")), revision }), "utf8").toString("base64url") }),
      totals,
      pageTotals: customerStatementPageTotals(paged.items)
    };
  });
}

// Shared historical balance and terminal-state rules for bill list and register.
function vendorBillRowsSql(billIdParameter = 10, currency = "$5", vendor = "$6", bill = `$${String(billIdParameter)}`): string { return `with bill_balances as (
  select document."subledger_document_id" as "bill_id", document."source_id", document."transaction_id",
    document."party_id", party."display_name" as "party_name", document."document_number",
    document."document_date", document."due_date", document."currency_code", document."original_amount",
    case
      when document."metadata" ->> 'provider' = 'quickbooks'
        and document."updated_at" < ($4::date + interval '1 day')
        then document."open_amount"
      else greatest(document."original_amount" - coalesce(applied."amount", 0), 0)::numeric
    end as "calculated_open_amount",
    document."version", document."payment_hold", document."payment_hold_reason",
    coalesce(terminal."correction_date", case
      when document."status" = 'voided' and document."updated_at" < ($4::date + interval '1 day')
        then document."updated_at"::date
      else null
    end) as "correction_date",
    replacement."has_replacement"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id" and party."party_type" = 'vendor'
  left join lateral (
    select sum(application."applied_amount") as "amount"
    from "erp_financials"."subledger_applications" application
    join "erp_financials"."financial_lifecycle_events" applied_event
      on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
     and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
    left join "erp_financials"."financial_lifecycle_events" ended_event
      on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
     and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
    where application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
      and application."source_id" = document."source_id" and application."target_document_id" = document."subledger_document_id"
      and application."application_type" in ('bill_payment_to_bill', 'vendor_credit_to_bill')
      and application."application_date" <= $4::date
      and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) < ($4::date + interval '1 day')
      and (ended_event."event_id" is null or coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) >= ($4::date + interval '1 day'))
  ) applied on true
  left join lateral (
    select related."transaction_date" as "correction_date"
    from "erp_financials"."journal_entry_links" link
    join "erp_financials"."transactions" related
      on related."tenant_id" = link."tenant_id" and related."source_id" = link."source_id"
     and related."transaction_id" = link."related_transaction_id"
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void')
    order by related."transaction_date", link."created_at" limit 1
  ) terminal on true
  left join lateral (
    select true as "has_replacement" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replacement on true
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'vendor_bill'
    and document."currency_code" = ${currency} and coalesce(document."recognition_date",document."document_date") <= $4::date
    and (${vendor}::text is null or document."party_id" = ${vendor})
    and (${bill}::text is null or document."subledger_document_id" = ${bill})
), bill_rows as (
  select *,
    case when "correction_date" <= $4::date then 0 else "calculated_open_amount" end as "open_amount",
    case
      when "correction_date" <= $4::date and "has_replacement" then 'replaced'
      when "correction_date" <= $4::date then 'voided'
      when "calculated_open_amount" = 0 then 'paid'
      when "due_date" < $4::date then 'overdue'
      when "calculated_open_amount" < "original_amount" then 'partial'
      else 'open'
    end as "status"
  from bill_balances
)
`; }
const VENDOR_BILL_ROWS_SQL = vendorBillRowsSql();

async function listVendorBills(
  scope: Scope,
  input: PageRequest & {
    readonly status?: VendorBillStatus;
    readonly asOfDate?: IsoDate;
    readonly vendorId?: string;
    readonly billId?: string;
  }
): Promise<Page<VendorBillListItem>> {
  const page = pageInput(input, "vendor-bills", scope.bookId);
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  if (input.vendorId !== undefined) assertNonEmpty(input.vendorId, "vendorId");
  if (input.status !== undefined && !VENDOR_BILL_STATUSES.has(input.status)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported vendor bill status ${input.status}`);
  }
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `${VENDOR_BILL_ROWS_SQL}select *, "document_date"::text as "document_date", "due_date"::text as "due_date" from bill_rows
where ($7::text is null or "status" = $7)
  and ($8::date is null or ("document_date", "bill_id") < ($8::date, $9::text))
order by bill_rows."document_date" desc, "bill_id" desc
limit $11`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        asOfDate,
        book.currencyCode,
        input.vendorId,
        input.status,
        page.date,
        page.id,
        input.billId,
        page.limit + 1
      ]
    );
    return toPage(result.rows.map(vendorBillFromRow), page.limit, "vendor-bills", scope.bookId, (item) => ({
      date: item.documentDate,
      id: item.billId
    }));
  });
}

const VENDOR_BILL_REGISTER_STATUSES: ReadonlySet<VendorBillRegisterStatus> = new Set(["open", "overdue", "on_hold", "paid", "voided", "replaced"]);

async function getCurrentInvoiceLinePage(scope: Scope, request: CurrentInvoiceLineRequest): Promise<CurrentInvoiceLinePage> {
  const input = structuredClone(request);
  assertNonEmpty(input.sourceId, "sourceId");
  if (!["draft", "posted"].includes(input.provenance)) throw new ErpFinancialsError("invalid_input", "Unsupported invoice line provenance");
  const kind = `current-invoice-lines:${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.provenance])).digest("hex")}`;
  const {limit} = pageInput({...(input.limit === undefined ? {} : {limit: input.limit})}, kind, scope.bookId);
  let afterId: string | undefined, afterLine: number | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try { if (input.cursor.length > 4096) throw new Error(); cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new ErpFinancialsError("invalid_input", "Current invoice line cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== kind || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 1000
      || typeof cursor.line !== "number" || !Number.isSafeInteger(cursor.line) || cursor.line < 1) throw new ErpFinancialsError("invalid_input", "Current invoice line cursor does not belong to this scope");
    afterId = cursor.id; afterLine = cursor.line;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope), draft = input.provenance === "draft";
    // Only fixed internal identifiers vary; every caller-supplied value is bound.
    const headers = draft ? "invoice_drafts" : "subledger_documents";
    const lines = draft ? "invoice_draft_lines" : "subledger_document_lines";
    const id = draft ? "invoice_draft_id" : "subledger_document_id";
    const lineId = draft ? "invoice_draft_line_id" : "subledger_document_line_id";
    const effectiveDate = draft ? "d.document_date" : "coalesce(d.recognition_date,d.document_date)";
    const result = await client.query(`select d.${id} invoice_id,d.version invoice_version,
 l.${lineId} line_id,l.line_number,l.account_id,l.item_id,l.description,l.quantity::text,l.unit_amount::text,l.unit_cost::text,
 l.discount_amount::text,l.tax_code,l.tax_amount::text,l.tax_account_id,l.discount_account_id,
 l.service_period_start::text,l.service_period_end::text,l.dimension_refs,l.line_amount::text,a.account_number
from erp_financials.${lines} l
join erp_financials.${headers} d on d.tenant_id=l.tenant_id and d.company_id=l.company_id and d.source_id=l.source_id and d.${id}=l.${id}
 ${draft ? "and d.book_id=l.book_id and d.book_id=$3 and d.status<>'issued'" : "and d.document_type='invoice'"}
join erp_financials.reporting_book_sources bs on bs.tenant_id=d.tenant_id and bs.company_id=d.company_id and bs.book_id=$3 and bs.source_id=d.source_id
 and (bs.effective_from is null or bs.effective_from<=${effectiveDate}) and (bs.effective_through is null or bs.effective_through>=${effectiveDate})
left join erp_financials.accounts a on a.tenant_id=l.tenant_id and a.source_id=l.source_id and a.account_id=l.account_id
where l.tenant_id=$1 and l.company_id=$2 and l.source_id=$4 ${draft ? "and l.book_id=$3" : ""} and d.currency_code=$5
 and ($6::text is null or (l.${id},l.line_number)>($6,$7::integer))
order by l.${id},l.line_number limit $8`,
      [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, book.currencyCode, afterId, afterLine, limit + 1]);
    const items = result.rows.slice(0, limit).map(row => ({...commercialLineFromRow(row), invoiceId: string(row.invoice_id, "invoice_id"), invoiceVersion: integer(row.invoice_version, "invoice_version")}));
    const last = items.at(-1);
    return {basis: "current", sourceId: input.sourceId, provenance: input.provenance, currencyCode: book.currencyCode, items,
      ...(result.rows.length > limit && last ? {nextCursor: Buffer.from(JSON.stringify({v: 1, kind, id: last.invoiceId, line: last.lineNumber}), "utf8").toString("base64url")} : {})};
  });
}

async function getCurrentVendorBillPage(scope: Scope, request: CurrentVendorBillRequest): Promise<CurrentVendorBillPage> {
  const input = structuredClone(request);
  assertNonEmpty(input.sourceId, "sourceId");
  const kind = `current-vendor-bills:${createHash("sha256").update(JSON.stringify([scope.tenantId,scope.companyId,scope.bookId,input.sourceId])).digest("hex")}`;
  const {limit} = pageInput({...(input.limit === undefined ? {} : {limit:input.limit})},kind,scope.bookId);
  let after: string | undefined;
  if(input.cursor !== undefined){
    let cursor: unknown;
    try{if(input.cursor.length>4096)throw new Error();cursor=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));}
    catch{throw new ErpFinancialsError("invalid_input","Current bill cursor is invalid");}
    if(!isRecord(cursor)||cursor.v!==1||cursor.kind!==kind||typeof cursor.id!=="string"||!cursor.id||cursor.id.length>1000)throw new ErpFinancialsError("invalid_input","Current bill cursor does not belong to this scope");
    after=cursor.id;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client,scope);
    const result = await client.query(`select d.subledger_document_id bill_id,d.source_id,d.transaction_id,d.party_id,d.document_number,
 d.document_date::text,d.due_date::text,d.currency_code,d.original_amount::text,d.open_amount::text,d.status,d.version,d.payment_hold,d.payment_hold_reason
from erp_financials.subledger_documents d
join erp_financials.reporting_book_sources bs on bs.tenant_id=d.tenant_id and bs.company_id=d.company_id and bs.book_id=$3 and bs.source_id=d.source_id
 and (bs.effective_from is null or bs.effective_from<=coalesce(d.recognition_date,d.document_date))
 and (bs.effective_through is null or bs.effective_through>=coalesce(d.recognition_date,d.document_date))
where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$4 and d.document_type='vendor_bill' and d.currency_code=$5
 and ($6::text is null or d.subledger_document_id>$6)
order by d.subledger_document_id limit $7`,
      [scope.tenantId,scope.companyId,scope.bookId,input.sourceId,book.currencyCode,after,limit+1]);
    const items: CurrentVendorBillItem[] = result.rows.map(row => {
      const status = string(row.status,"status");
      if (!["open","partially_applied","settled","voided"].includes(status)) throw new ErpFinancialsError("invalid_input","Unsupported current bill status");
      const documentNumber = optionalString(row.document_number);
      return {billId:string(row.bill_id,"billId"),sourceId:string(row.source_id,"sourceId"),transactionId:string(row.transaction_id,"transactionId"),
        vendorId:string(row.party_id,"vendorId"),...(documentNumber === undefined ? {} : {documentNumber}),version:integer(row.version,"version"),
        documentDate:date(row.document_date,"documentDate"),dueDate:date(row.due_date,"dueDate"),currencyCode:string(row.currency_code,"currencyCode"),
        originalAmount:money(row.original_amount,"originalAmount"),openAmount:money(row.open_amount,"openAmount"),status:status as CurrentVendorBillItem["status"],
        paymentHold:row.payment_hold===true,paymentHoldReason:optionalString(row.payment_hold_reason)??null};
    });
    const selected=items.slice(0,limit),last=selected.at(-1);
    return {basis:"current",sourceId:input.sourceId,currencyCode:book.currencyCode,items:selected,
      ...(items.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:1,kind,id:last.billId}),"utf8").toString("base64url")}: {})};
  });
}

async function getVendorBillRegister(scope: Scope, input: VendorBillRegisterRequest): Promise<VendorBillRegisterPage> {
  input = structuredClone(input);
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  const dueSoon = new Date(`${asOfDate}T00:00:00Z`); dueSoon.setUTCDate(dueSoon.getUTCDate() + 7);
  const dueSoonThrough = dueSoon.toISOString().slice(0, 10); assertDate(dueSoonThrough, "dueSoonThrough");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "vendor-bill-register", scope.bookId);
  if (input.vendorId !== undefined) assertNonEmpty(input.vendorId, "vendorId");
  if (input.status !== undefined && !VENDOR_BILL_REGISTER_STATUSES.has(input.status)) throw new ErpFinancialsError("invalid_input", "Unsupported vendor bill register status");
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, asOfDate, input.vendorId ?? null, input.status ?? null])).digest("hex");
  let boundaryDate: string | undefined, boundaryId: string | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (input.cursor.length > 4096) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Vendor bill register cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "vendor-bill-register" || cursor.scope !== fingerprint ||
      typeof cursor.date !== "string" || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 512) {
      throw new ErpFinancialsError("invalid_input", "Vendor bill register cursor does not belong to this scope or filter");
    }
    assertDate(cursor.date, "cursor.date"); boundaryDate = cursor.date; boundaryId = cursor.id;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    // Page and global totals are derived in one PostgreSQL statement/snapshot.
    const result = await client.query(`${VENDOR_BILL_ROWS_SQL}, register_rows as materialized (
  select *, ("original_amount" - "calculated_open_amount") as "applied_amount",
    case when "status" in ('paid','voided','replaced') then "status"
      when "payment_hold" then 'on_hold' when "status"='overdue' then 'overdue' else 'open' end as "register_status"
  from bill_rows
), summary as (
  select count(*)::text as "count_all",
    count(*) filter(where "register_status"='open')::text as "count_open",
    count(*) filter(where "register_status"='overdue')::text as "count_overdue",
    count(*) filter(where "register_status"='on_hold')::text as "count_on_hold",
    count(*) filter(where "register_status"='paid')::text as "count_paid",
    count(*) filter(where "register_status"='voided')::text as "count_voided",
    count(*) filter(where "register_status"='replaced')::text as "count_replaced",
    coalesce(sum("open_amount"),0) as "outstanding_amount", count(*) filter(where "open_amount">0)::text as "outstanding_count",
    coalesce(sum("open_amount") filter(where "due_date"<$4::date),0) as "overdue_amount",
    count(*) filter(where "open_amount">0 and "due_date"<$4::date)::text as "overdue_count",
    coalesce(sum("open_amount") filter(where "due_date" between $4::date and $12::date),0) as "due_soon_amount",
    count(*) filter(where "open_amount">0 and "due_date" between $4::date and $12::date)::text as "due_soon_count"
  from register_rows
), page_rows as (
  select * from register_rows where ($7::text is null or "register_status"=$7)
    and ($8::date is null or ("due_date","bill_id")>($8::date,$9::text))
  order by "due_date","bill_id" limit $11
)
select summary.*,page_rows.*,page_rows."document_date"::text as "document_date",page_rows."due_date"::text as "due_date"
from summary left join page_rows on true order by page_rows."due_date",page_rows."bill_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, asOfDate, book.currencyCode, input.vendorId, input.status,
        boundaryDate, boundaryId, null, limit + 1, dueSoonThrough]);
    const total = requiredRow(result.rows[0], "vendor bill register summary");
    const count = (key: string) => { const value = string(total[key], key); if (!/^(0|[1-9]\d*)$/u.test(value)) throw new ErpFinancialsError("invalid_input", "Invalid register count"); return value; };
    const summary: VendorBillRegisterSummary = { asOfDate, currencyCode: book.currencyCode, dueSoonThrough,
      outstandingAmount: money(total.outstanding_amount, "outstanding_amount"), outstandingBillCount: count("outstanding_count"),
      overdueAmount: money(total.overdue_amount, "overdue_amount"), overdueBillCount: count("overdue_count"),
      dueSoonAmount: money(total.due_soon_amount, "due_soon_amount"), dueSoonBillCount: count("due_soon_count"),
      counts: { all: count("count_all"), open: count("count_open"), overdue: count("count_overdue"), on_hold: count("count_on_hold"),
        paid: count("count_paid"), voided: count("count_voided"), replaced: count("count_replaced") } };
    const candidates = result.rows.filter(row => row.bill_id !== null);
    const items = candidates.slice(0, limit).map(row => ({ ...vendorBillFromRow(row), registerStatus: string(row.register_status, "register_status") as VendorBillRegisterStatus,
      appliedAmount: money(row.applied_amount, "applied_amount"), paymentHold: row.payment_hold === true, paymentHoldReason: optionalString(row.payment_hold_reason) ?? null }));
    const last = items.at(-1);
    return { items, summary, ...(candidates.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1,
      kind: "vendor-bill-register", scope: fingerprint, date: last.dueDate, id: last.billId }), "utf8").toString("base64url") } : {}) };
  });
}

async function getVendorBillCorrectionReview(scope: Scope, request: VendorBillCorrectionReviewRequest): Promise<VendorBillCorrectionReviewPage> {
  const input = structuredClone(request);
  assertNonEmpty(input.sourceId, "sourceId"); assertNonEmpty(input.billId, "billId");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "vendor-bill-correction-review", scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.billId])).digest("hex");
  let boundaryDate: string | undefined, boundaryId: string | undefined, priorReview: string | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (input.cursor.length > 4096) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Correction review cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "vendor-bill-correction-review" || cursor.scope !== fingerprint ||
      typeof cursor.date !== "string" || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 1000 ||
      typeof cursor.review !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.review)) throw new ErpFinancialsError("invalid_input", "Correction review cursor does not belong to this scope");
    assertDate(cursor.date, "cursor.date"); boundaryDate = cursor.date; boundaryId = cursor.id; priorReview = cursor.review;
  }
  return scope.database.transaction(async client => {
    // One SQL snapshot for header, every active-source version, totals and page.
    // Only the bill's active applications are aggregated; ended history is not read.
    const result = await client.query(`with bill as materialized (
select d.* from erp_financials.subledger_documents d
join erp_financials.reporting_books b on b.tenant_id=d.tenant_id and b.company_id=d.company_id and b.book_id=$3 and b.status='active' and b.base_currency_code=d.currency_code
join erp_financials.reporting_book_sources bs on bs.tenant_id=d.tenant_id and bs.company_id=d.company_id and bs.book_id=b.book_id and bs.source_id=d.source_id
 and (bs.effective_from is null or bs.effective_from<=coalesce(d.recognition_date,d.document_date)) and (bs.effective_through is null or bs.effective_through>=coalesce(d.recognition_date,d.document_date))
join erp_financials.accounting_sources src on src.tenant_id=d.tenant_id and src.source_id=d.source_id and src.source_system='native_erp'
join erp_financials.financial_outbox origin on origin.tenant_id=d.tenant_id and origin.company_id=d.company_id and origin.source_id=d.source_id
 and origin.idempotency_key='ledger-posted:Subledger:vendor_bill:'||d.idempotency_key and origin.aggregate_id=d.transaction_id and origin.event_type='ledger.posted' and origin.book_id=$3
where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$4 and d.subledger_document_id=$5 and d.document_type='vendor_bill'
), active as materialized (
select a.subledger_application_id as application_id,a.version,a.application_type,a.application_date,a.applied_amount,
 s.subledger_document_id as source_document_id,s.document_type as source_document_type,s.version as source_version,
 s.open_amount as source_open_amount,s.original_amount as source_original_amount,
 (((a.application_type='bill_payment_to_bill' and s.document_type='bill_payment') or (a.application_type='vendor_credit_to_bill' and s.document_type='vendor_credit')) and s.party_id=bill.party_id and s.currency_code=bill.currency_code
 and evidence.book_id=$3 and evidence.event_type='ledger.posted' and evidence.aggregate_id=s.transaction_id) as supported
from bill join erp_financials.subledger_applications a on a.tenant_id=bill.tenant_id and a.company_id=bill.company_id and a.source_id=bill.source_id
 and a.target_document_id=bill.subledger_document_id and a.status='applied'
join erp_financials.subledger_documents s on s.tenant_id=a.tenant_id and s.company_id=a.company_id and s.source_id=a.source_id and s.subledger_document_id=a.source_document_id
left join erp_financials.financial_outbox evidence on evidence.tenant_id=s.tenant_id and evidence.company_id=s.company_id and evidence.source_id=s.source_id
 and evidence.idempotency_key='ledger-posted:Subledger:'||s.document_type||':'||s.idempotency_key
), controls as (
 select count(*)::text as active_count,coalesce(sum(applied_amount),0)::text as applied_amount,
 coalesce(bool_and(coalesce(supported,false)),true) as supported,
 md5(coalesce(string_agg(jsonb_build_array(application_id,version,application_type,application_date,applied_amount::text,
 source_document_id,source_document_type,source_version,source_open_amount::text,source_original_amount::text,supported)::text,',' order by application_id),'')) as revision
 from active
), page as (
 select * from active where ($6::date is null or (application_date,application_id)>($6::date,$7::text))
 order by application_date,application_id limit $8
)
select jsonb_build_object('billId',bill.subledger_document_id,'sourceId',bill.source_id,'vendorId',bill.party_id,'version',bill.version,
 'documentDate',bill.document_date::text,'dueDate',bill.due_date::text,'currencyCode',bill.currency_code,
 'originalAmount',bill.original_amount::text,'openAmount',bill.open_amount::text,'status',bill.status,
 'paymentHold',bill.payment_hold,'paymentHoldReason',bill.payment_hold_reason) as bill,
 controls.active_count,controls.applied_amount,controls.supported,controls.revision,
 coalesce((select jsonb_agg(jsonb_build_object('applicationId',application_id,'version',version,'applicationType',application_type,
 'applicationDate',application_date::text,'amount',applied_amount::text,'sourceDocumentId',source_document_id,'sourceDocumentType',source_document_type,
 'sourceVersion',source_version,'sourceOpenAmount',source_open_amount::text,'sourceOriginalAmount',source_original_amount::text)
 order by application_date,application_id) from page),'[]'::jsonb) as items
from bill cross join controls`, [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.billId, boundaryDate, boundaryId, limit + 1]);
    const row = result.rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Native vendor bill is not available in this correction scope");
    if (row.supported !== true) throw new ErpFinancialsError("unsupported_operation", "Active applications require native source evidence in the correction book");
    const header = jsonObject(row.bill, "bill");
    const status = string(header.status, "status") as VendorBillCorrectionReviewPage["bill"]["status"];
    if (status === "voided") throw new ErpFinancialsError("terminal_state_conflict", "A voided bill cannot be reviewed for another correction");
    const bill: VendorBillCorrectionReviewPage["bill"] = { billId: string(header.billId, "billId"), sourceId: string(header.sourceId, "sourceId"), vendorId: string(header.vendorId, "vendorId"),
      version: integer(header.version, "version"), documentDate: date(header.documentDate, "documentDate"), dueDate: date(header.dueDate, "dueDate"), currencyCode: string(header.currencyCode, "currencyCode"),
      originalAmount: money(header.originalAmount, "originalAmount"), openAmount: money(header.openAmount, "openAmount"), status,
      paymentHold: header.paymentHold === true, paymentHoldReason: optionalString(header.paymentHoldReason) ?? null };
    const reviewToken = createHash("sha256").update(JSON.stringify([fingerprint, bill, row.revision])).digest("hex");
    if (priorReview !== undefined && priorReview !== reviewToken) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Bill correction review changed; restart from the first page", { retryable: true });
    const values: unknown = row.items;
    if (!Array.isArray(values)) throw new ErpFinancialsError("invalid_input", "Invalid stored correction review page");
    const items = values.slice(0, limit).map((value: unknown): VendorBillCorrectionReviewApplication => {
      const item = jsonObject(value, "application");
      return { applicationId: string(item.applicationId, "applicationId"), version: integer(item.version, "version"),
        applicationType: string(item.applicationType, "applicationType") as VendorBillCorrectionReviewApplication["applicationType"],
        applicationDate: date(item.applicationDate, "applicationDate"), amount: money(item.amount, "amount"), sourceDocumentId: string(item.sourceDocumentId, "sourceDocumentId"),
        sourceDocumentType: string(item.sourceDocumentType, "sourceDocumentType") as VendorBillCorrectionReviewApplication["sourceDocumentType"],
        sourceVersion: integer(item.sourceVersion, "sourceVersion"), sourceOpenAmount: money(item.sourceOpenAmount, "sourceOpenAmount"), sourceOriginalAmount: money(item.sourceOriginalAmount, "sourceOriginalAmount") };
    });
    const last = items.at(-1);
    return { bill, reviewToken, activeApplicationCount: string(row.active_count, "active_count"), appliedAmount: money(row.applied_amount, "applied_amount"), items,
      ...(values.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "vendor-bill-correction-review", scope: fingerprint,
        review: reviewToken, date: last.applicationDate, id: last.applicationId })).toString("base64url") } : {}) };
  });
}

async function getInvoiceCorrectionReview(scope: Scope, request: InvoiceCorrectionReviewRequest): Promise<InvoiceCorrectionReviewPage> {
  const input = structuredClone(request);
  assertNonEmpty(input.sourceId, "sourceId"); assertNonEmpty(input.invoiceId, "invoiceId");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "invoice-correction-review", scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.invoiceId])).digest("hex");
  let boundaryDate: string | undefined, boundaryId: string | undefined, priorReview: string | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (input.cursor.length > 4096) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Correction review cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "invoice-correction-review" || cursor.scope !== fingerprint ||
      typeof cursor.date !== "string" || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 1000 ||
      typeof cursor.review !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.review)) throw new ErpFinancialsError("invalid_input", "Correction review cursor does not belong to this scope");
    assertDate(cursor.date, "cursor.date"); boundaryDate = cursor.date; boundaryId = cursor.id; priorReview = cursor.review;
  }
  return scope.database.transaction(async client => {
    // One SQL snapshot for header, every active-source version, totals and page.
    // Only the invoice's active applications are aggregated; ended history is not read.
    const result = await client.query(`with invoice as materialized (
select d.*,cancel.invoice_void_id as cancellation_id from erp_financials.subledger_documents d
join erp_financials.reporting_books b on b.tenant_id=d.tenant_id and b.company_id=d.company_id and b.book_id=$3 and b.status='active' and b.base_currency_code=d.currency_code
join erp_financials.reporting_book_sources bs on bs.tenant_id=d.tenant_id and bs.company_id=d.company_id and bs.book_id=b.book_id and bs.source_id=d.source_id
 and (bs.effective_from is null or bs.effective_from<=coalesce(d.recognition_date,d.document_date)) and (bs.effective_through is null or bs.effective_through>=coalesce(d.recognition_date,d.document_date))
join erp_financials.accounting_sources src on src.tenant_id=d.tenant_id and src.source_id=d.source_id and src.source_system='native_erp'
join erp_financials.financial_outbox origin on origin.tenant_id=d.tenant_id and origin.company_id=d.company_id and origin.source_id=d.source_id
 and origin.idempotency_key='ledger-posted:Subledger:invoice:'||d.idempotency_key and origin.aggregate_id=d.transaction_id and origin.event_type='ledger.posted' and origin.book_id=$3
left join erp_financials.invoice_voids cancel on cancel.tenant_id=d.tenant_id and cancel.company_id=d.company_id and cancel.source_id=d.source_id and cancel.book_id=$3 and cancel.invoice_document_id=d.subledger_document_id
where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$4 and d.subledger_document_id=$5 and d.document_type='invoice'
), active as materialized (
select a.subledger_application_id as application_id,a.version,a.application_type,a.application_date,a.applied_amount,
 s.subledger_document_id as source_document_id,s.document_type as source_document_type,s.version as source_version,
 s.open_amount as source_open_amount,s.original_amount as source_original_amount,
 (((a.application_type='customer_payment_to_invoice' and s.document_type='customer_payment') or (a.application_type='credit_to_invoice' and s.document_type='credit_memo')) and s.party_id=invoice.party_id and s.currency_code=invoice.currency_code
 and evidence.book_id=$3 and evidence.event_type='ledger.posted' and evidence.aggregate_id=s.transaction_id) as supported
from invoice join erp_financials.subledger_applications a on a.tenant_id=invoice.tenant_id and a.company_id=invoice.company_id and a.source_id=invoice.source_id
 and a.target_document_id=invoice.subledger_document_id and a.status='applied'
join erp_financials.subledger_documents s on s.tenant_id=a.tenant_id and s.company_id=a.company_id and s.source_id=a.source_id and s.subledger_document_id=a.source_document_id
left join erp_financials.financial_outbox evidence on evidence.tenant_id=s.tenant_id and evidence.company_id=s.company_id and evidence.source_id=s.source_id
 and evidence.idempotency_key='ledger-posted:Subledger:'||s.document_type||':'||s.idempotency_key
), controls as (
 select count(*)::text as active_count,coalesce(sum(applied_amount),0)::text as applied_amount,
 coalesce(bool_and(coalesce(supported,false)),true) as supported,
 md5(coalesce(string_agg(jsonb_build_array(application_id,version,application_type,application_date,applied_amount::text,
 source_document_id,source_document_type,source_version,source_open_amount::text,source_original_amount::text,supported)::text,',' order by application_id),'')) as revision
 from active
), page as (
 select * from active where ($6::date is null or (application_date,application_id)>($6::date,$7::text))
 order by application_date,application_id limit $8
)
select jsonb_build_object('invoiceId',invoice.subledger_document_id,'sourceId',invoice.source_id,'customerId',invoice.party_id,'version',invoice.version,
 'documentDate',invoice.document_date::text,'recognitionDate',invoice.recognition_date::text,'dueDate',invoice.due_date::text,'currencyCode',invoice.currency_code,
 'originalAmount',invoice.original_amount::text,'openAmount',invoice.open_amount::text,'status',case when invoice.cancellation_id is not null then 'voided' else invoice.status end,
 'documentNumber',invoice.document_number) as invoice,
 controls.active_count,controls.applied_amount,controls.supported,controls.revision,
 coalesce((select jsonb_agg(jsonb_build_object('applicationId',application_id,'version',version,'applicationType',application_type,
 'applicationDate',application_date::text,'amount',applied_amount::text,'sourceDocumentId',source_document_id,'sourceDocumentType',source_document_type,
 'sourceVersion',source_version,'sourceOpenAmount',source_open_amount::text,'sourceOriginalAmount',source_original_amount::text)
 order by application_date,application_id) from page),'[]'::jsonb) as items
from invoice cross join controls`, [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.invoiceId, boundaryDate, boundaryId, limit + 1]);
    const row = result.rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Native invoice is not available in this correction scope");
    if (row.supported !== true) throw new ErpFinancialsError("unsupported_operation", "Active applications require native source evidence in the correction book");
    const header = jsonObject(row.invoice, "invoice");
    const status = string(header.status, "status") as InvoiceCorrectionReviewPage["invoice"]["status"];
    if (status === "voided") throw new ErpFinancialsError("terminal_state_conflict", "A voided invoice cannot be reviewed for another correction");
    const invoice: InvoiceCorrectionReviewPage["invoice"] = { invoiceId: string(header.invoiceId, "invoiceId"), sourceId: string(header.sourceId, "sourceId"), customerId: string(header.customerId, "customerId"),
      version: integer(header.version, "version"), documentDate: date(header.documentDate, "documentDate"), dueDate: date(header.dueDate, "dueDate"), currencyCode: string(header.currencyCode, "currencyCode"),
      ...(header.recognitionDate == null ? {} : { recognitionDate: date(header.recognitionDate,"recognitionDate") }),
      originalAmount: money(header.originalAmount, "originalAmount"), openAmount: money(header.openAmount, "openAmount"), status,
      ...(optionalString(header.documentNumber) === undefined ? {} : { documentNumber: string(header.documentNumber, "documentNumber") }) };
    const reviewToken = createHash("sha256").update(JSON.stringify([fingerprint, invoice, row.revision])).digest("hex");
    if (priorReview !== undefined && priorReview !== reviewToken) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Invoice correction review changed; restart from the first page", { retryable: true });
    const values: unknown = row.items;
    if (!Array.isArray(values)) throw new ErpFinancialsError("invalid_input", "Invalid stored correction review page");
    const items = values.slice(0, limit).map((value: unknown): InvoiceCorrectionReviewApplication => {
      const item = jsonObject(value, "application");
      return { applicationId: string(item.applicationId, "applicationId"), version: integer(item.version, "version"),
        applicationType: string(item.applicationType, "applicationType") as InvoiceCorrectionReviewApplication["applicationType"],
        applicationDate: date(item.applicationDate, "applicationDate"), amount: money(item.amount, "amount"), sourceDocumentId: string(item.sourceDocumentId, "sourceDocumentId"),
        sourceDocumentType: string(item.sourceDocumentType, "sourceDocumentType") as InvoiceCorrectionReviewApplication["sourceDocumentType"],
        sourceVersion: integer(item.sourceVersion, "sourceVersion"), sourceOpenAmount: money(item.sourceOpenAmount, "sourceOpenAmount"), sourceOriginalAmount: money(item.sourceOriginalAmount, "sourceOriginalAmount") };
    });
    const last = items.at(-1);
    return { invoice, reviewToken, activeApplicationCount: string(row.active_count, "active_count"), appliedAmount: money(row.applied_amount, "applied_amount"), items,
      ...(values.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "invoice-correction-review", scope: fingerprint,
        review: reviewToken, date: last.applicationDate, id: last.applicationId })).toString("base64url") } : {}) };
  });
}

async function getVendorBill(
  scope: Scope,
  billId: string,
  asOfDate = today()
): Promise<VendorBillDetail> {
  assertNonEmpty(billId, "billId");
  assertDate(asOfDate, "asOfDate");
  const page = await listVendorBills(scope, { billId, limit: 1, asOfDate });
  const bill = page.items[0];
  if (bill === undefined) {
    throw new ErpFinancialsError(
      "missing_document",
      `Vendor bill ${billId} does not exist in reporting book ${scope.bookId} as of ${asOfDate}`,
      { details: { asOfDate, billId, bookId: scope.bookId } }
    );
  }
  return scope.database.transaction(async (client) => {
    const header = await client.query(
      `select transaction."memo"
from "erp_financials"."subledger_documents" document
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."source_id" = $3
  and document."subledger_document_id" = $4 and document."document_type" = 'vendor_bill'`,
      [scope.tenantId, scope.companyId, bill.sourceId, bill.billId]
    );
    const lines = await client.query(
      `select line."subledger_document_line_id" as "line_id", line.*, line."service_period_start"::text as "service_period_start", line."service_period_end"::text as "service_period_end",
  account."source_account_id", account."name" as "source_account_name",
  mapping."book_account_mapping_id", mapping."book_account_key",
  customer."party_id" as "customer_party_id", customer."display_name" as "customer_name",
  item."source_item_id", item."name" as "item_name", item."expense_account_id" as "item_expense_account_id"
from "erp_financials"."subledger_document_lines" line
join "erp_financials"."accounts" account
  on account."tenant_id" = line."tenant_id" and account."source_id" = line."source_id"
 and account."account_id" = line."account_id"
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = line."tenant_id" and mapping."company_id" = line."company_id"
 and mapping."book_id" = $3 and mapping."source_id" = line."source_id" and mapping."account_id" = line."account_id"
left join "erp_financials"."items" item
  on item."tenant_id" = line."tenant_id" and item."source_id" = line."source_id" and item."item_id" = line."item_id"
left join "erp_financials"."parties" customer
  on customer."tenant_id" = line."tenant_id" and customer."source_id" = line."source_id"
 and customer."party_id" = line."customer_party_id"
where line."tenant_id" = $1 and line."company_id" = $2 and line."source_id" = $4
  and line."subledger_document_id" = $5
order by line."line_number"`,
      [scope.tenantId, scope.companyId, scope.bookId, bill.sourceId, bill.billId]
    );
    const applications = await client.query(
      `select application."subledger_application_id" as "application_id",
  application."source_document_id" as "source_payment_id", application."application_date"::text as "application_date",
  application."applied_amount", application."version",
  case when coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) < ($5::date + interval '1 day') then application."status" else 'applied' end as "status"
from "erp_financials"."subledger_applications" application
join "erp_financials"."financial_lifecycle_events" applied_event
  on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
 and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
left join "erp_financials"."financial_lifecycle_events" ended_event
  on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
 and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
where application."tenant_id" = $1 and application."company_id" = $2 and application."source_id" = $3
  and application."target_document_id" = $4 and application."application_type" = 'bill_payment_to_bill'
  and application."application_date" <= $5::date and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) < ($5::date + interval '1 day')
order by application."application_date", application."subledger_application_id"`,
      [scope.tenantId, scope.companyId, bill.sourceId, bill.billId, asOfDate]
    );
    const memo = optionalString(header.rows[0]?.memo);
    return {
      ...bill,
      ...(memo === undefined ? {} : { memo }),
      lines: lines.rows.map(vendorBillLineFromRow),
      applications: applications.rows.map(vendorBillApplicationFromRow)
    };
  });
}

async function getVendorBillSummary(
  scope: Scope,
  input: {
    readonly asOfDate?: IsoDate;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly vendorId?: string;
  }
): Promise<VendorBillSummary> {
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  const periodEnd = input.periodEnd ?? asOfDate;
  const periodStart = input.periodStart ?? `${periodEnd.slice(0, 7)}-01`;
  assertWindow(periodStart, periodEnd);
  if (periodEnd > asOfDate) {
    throw new ErpFinancialsError("invalid_input", "periodEnd must be on or before asOfDate");
  }
  if (input.vendorId !== undefined) assertNonEmpty(input.vendorId, "vendorId");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with bills as (
  select document."original_amount", document."due_date",
    case
      when document."metadata" ->> 'provider' = 'quickbooks'
        and document."updated_at" < ($4::date + interval '1 day')
        then document."open_amount"
      else greatest(document."original_amount" - coalesce(applied."amount", 0), 0)::numeric
    end as "open_amount",
    coalesce(period_applied."amount", 0)::numeric as "paid_in_period_amount",
    coalesce(terminal."correction_date", case
      when document."status" = 'voided' and document."updated_at" < ($4::date + interval '1 day')
        then document."updated_at"::date
      else null
    end) as "correction_date",
    replacement."has_replacement"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join lateral (
    select sum(application."applied_amount") as "amount"
    from "erp_financials"."subledger_applications" application
    join "erp_financials"."financial_lifecycle_events" applied_event
      on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
     and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
    left join "erp_financials"."financial_lifecycle_events" ended_event
      on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
     and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
    where application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
      and application."source_id" = document."source_id" and application."target_document_id" = document."subledger_document_id"
      and application."application_type" in ('bill_payment_to_bill', 'vendor_credit_to_bill')
      and application."application_date" <= $4::date
      and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) < ($4::date + interval '1 day')
      and (ended_event."event_id" is null or coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) >= ($4::date + interval '1 day'))
  ) applied on true
  left join lateral (
    select sum(application."applied_amount") as "amount"
    from "erp_financials"."subledger_applications" application
    join "erp_financials"."financial_lifecycle_events" applied_event
      on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
     and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
    left join "erp_financials"."financial_lifecycle_events" ended_event
      on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
     and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
    where application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
      and application."source_id" = document."source_id" and application."target_document_id" = document."subledger_document_id"
      and application."application_type" = 'bill_payment_to_bill'
      and application."application_date" between $7::date and $8::date
      and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) < ($4::date + interval '1 day')
      and (ended_event."event_id" is null or coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) >= ($4::date + interval '1 day'))
  ) period_applied on true
  left join lateral (
    select related."transaction_date" as "correction_date"
    from "erp_financials"."journal_entry_links" link
    join "erp_financials"."transactions" related
      on related."tenant_id" = link."tenant_id" and related."source_id" = link."source_id"
     and related."transaction_id" = link."related_transaction_id"
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void')
    order by related."transaction_date", link."created_at" limit 1
  ) terminal on true
  left join lateral (
    select true as "has_replacement" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replacement on true
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'vendor_bill'
    and document."currency_code" = $5 and coalesce(document."recognition_date",document."document_date") <= $4::date
    and ($6::text is null or document."party_id" = $6)
)
select
  coalesce(sum("open_amount") filter (where "correction_date" is null or "correction_date" > $4::date), 0) as "outstanding_amount",
  count(*) filter (where "open_amount" > 0 and ("correction_date" is null or "correction_date" > $4::date))::integer as "outstanding_count",
  coalesce(sum("open_amount") filter (where "open_amount" > 0 and "due_date" < $4::date
    and ("correction_date" is null or "correction_date" > $4::date)), 0) as "overdue_amount",
  count(*) filter (where "open_amount" > 0 and "due_date" < $4::date
    and ("correction_date" is null or "correction_date" > $4::date))::integer as "overdue_count",
  coalesce(sum("original_amount" - "open_amount") filter (where "correction_date" is null or "correction_date" > $4::date), 0) as "paid_amount",
  coalesce(sum("paid_in_period_amount") filter (where "correction_date" is null or "correction_date" > $4::date), 0) as "paid_in_period_amount",
  count(*) filter (where "paid_in_period_amount" > 0
    and ("correction_date" is null or "correction_date" > $4::date))::integer as "paid_in_period_count",
  count(*) filter (where "open_amount" = 0 and ("correction_date" is null or "correction_date" > $4::date))::integer as "settled_count",
  count(*) filter (where "correction_date" <= $4::date and "has_replacement" is not true)::integer as "voided_count",
  count(*) filter (where "correction_date" <= $4::date and "has_replacement")::integer as "replaced_count"
from bills`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        asOfDate,
        book.currencyCode,
        input.vendorId,
        periodStart,
        periodEnd
      ]
    );
    const row = requiredRow(result.rows[0], "vendor bill summary");
    return {
      asOfDate,
      periodStart,
      periodEnd,
      currencyCode: book.currencyCode,
      outstandingAmount: money(row.outstanding_amount, "outstanding_amount"),
      outstandingVendorBillCount: integer(row.outstanding_count, "outstanding_count"),
      overdueAmount: money(row.overdue_amount, "overdue_amount"),
      overdueVendorBillCount: integer(row.overdue_count, "overdue_count"),
      paidAmount: money(row.paid_amount, "paid_amount"),
      paidInPeriodAmount: money(row.paid_in_period_amount, "paid_in_period_amount"),
      paidInPeriodVendorBillCount: integer(row.paid_in_period_count, "paid_in_period_count"),
      settledVendorBillCount: integer(row.settled_count, "settled_count"),
      voidedVendorBillCount: integer(row.voided_count, "voided_count"),
      replacedVendorBillCount: integer(row.replaced_count, "replaced_count")
    };
  });
}

const CUSTOMER_PAYMENT_REGISTER_FILTERS: ReadonlySet<CustomerPaymentRegisterFilter> = new Set([
  "all", "automatic", "manual", "unapplied"
]);
const CUSTOMER_PAYMENT_REGISTER_SORTS: ReadonlySet<CustomerPaymentRegisterSort> = new Set([
  "payment", "customer", "date", "method", "appliedTo", "match", "amount"
]);
const CUSTOMER_PAYMENT_REGISTER_DIRECTIONS: ReadonlySet<CustomerPaymentRegisterDirection> = new Set(["asc", "desc"]);
const CUSTOMER_PAYMENT_REGISTER_TRAVERSALS = new Set(["forward", "backward"]);

type CustomerPaymentRegisterOrdering = {
  readonly expression: string;
  readonly cast: "text" | "date" | "numeric";
  readonly direction: CustomerPaymentRegisterDirection;
  readonly nulls: "first" | "last";
};

async function listCustomerPaymentRegister(
  scope: Scope,
  input: {
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly sort: CustomerPaymentRegisterSort;
    readonly direction: CustomerPaymentRegisterDirection;
    readonly limit: number;
    readonly filter?: CustomerPaymentRegisterFilter;
    readonly boundary?: CustomerPaymentRegisterBoundary;
  }
): Promise<CustomerPaymentRegisterProjection> {
  assertWindow(input.periodStart, input.periodEnd);
  const filter = input.filter ?? "all";
  if (!CUSTOMER_PAYMENT_REGISTER_FILTERS.has(filter)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported customer payment register filter");
  }
  if (!CUSTOMER_PAYMENT_REGISTER_SORTS.has(input.sort)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported customer payment register sort");
  }
  if (!CUSTOMER_PAYMENT_REGISTER_DIRECTIONS.has(input.direction)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported customer payment register direction");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new ErpFinancialsError("invalid_input", "Customer payment register limit must be an integer between 1 and 200");
  }
  const boundary = customerPaymentRegisterBoundary(input.boundary, input.sort, input.direction);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const traversal = boundary?.traversal ?? "forward";
    const ordering = customerPaymentRegisterOrdering(input.sort, input.direction, traversal);
    const parameters: unknown[] = [
      scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.periodStart, input.periodEnd, filter
    ];
    let boundarySql = "";
    if (boundary !== undefined) {
      parameters.push(boundary.value, boundary.paymentId);
      boundarySql = customerPaymentRegisterBoundarySql(ordering, boundary.value === null);
    }
    parameters.push(input.limit + 1);
    const result = await client.query(
      `with payment_rows as (
  select document."subledger_document_id" as "payment_id", document."source_id", document."document_type",
    document."transaction_id", document."party_id", party."display_name" as "party_name", document."document_number",
    document."document_date", document."currency_code", document."original_amount", document."open_amount",
    document."version", document."lifecycle_event_id", coalesce(apps."application_count", 0)::integer as "application_count",
    coalesce(apps."returned_amount", 0) as "returned_amount",
    coalesce(nullif(document."metadata"->>'paymentMethod', ''), nullif(document."metadata"->>'payment_method', ''), 'Imported') as "payment_method",
    apps."applied_to",
    case when coalesce(apps."automatic", false) then 'automatic'
      when coalesce(apps."application_count", 0) > 0 then 'manual' else 'unmatched' end as "matching_mode",
    case when coalesce(apps."automatic", false) then 'Automatically matched'
      when coalesce(apps."application_count", 0) > 0 then 'Canonical application' else 'Awaiting bank review' end as "match_label",
    case when document."status" = 'voided' then 'voided'
      when coalesce(apps."returned_amount", 0) = document."original_amount" then 'returned'
      when document."open_amount" = 0 then 'applied'
      when document."open_amount" = document."original_amount" then 'unapplied' else 'partial' end as "payment_status"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id"
  left join lateral (
    select count(*) filter (where application."application_type" = 'customer_payment_to_invoice')::integer as "application_count",
      bool_or(application."match_method" = 'automatic') filter (where application."application_type" = 'customer_payment_to_invoice') as "automatic",
      coalesce(sum(application."applied_amount") filter (where application."application_type" = 'customer_payment_to_refund'), 0) as "returned_amount",
      string_agg(coalesce(nullif(trim(invoice."document_number"), ''), 'Invoice'), ', '
        order by invoice."document_number" collate "C", application."subledger_application_id" collate "C") filter (where application."application_type" = 'customer_payment_to_invoice') as "applied_to"
    from "erp_financials"."subledger_applications" application
    join "erp_financials"."reporting_book_sources" application_source
      on application_source."tenant_id" = application."tenant_id" and application_source."company_id" = application."company_id"
     and application_source."book_id" = $3 and application_source."source_id" = application."source_id"
     and (application_source."effective_from" is null or application_source."effective_from" <= application."application_date")
     and (application_source."effective_through" is null or application_source."effective_through" >= application."application_date")
    join "erp_financials"."subledger_documents" invoice
      on invoice."tenant_id" = application."tenant_id" and invoice."company_id" = application."company_id"
     and invoice."source_id" = application."source_id" and invoice."subledger_document_id" = application."target_document_id"
     and invoice."document_type" in ('invoice', 'refund') and invoice."currency_code" = $4
    where application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
      and application."source_id" = document."source_id"
      and application."source_document_id" = document."subledger_document_id"
      and application."application_type" in ('customer_payment_to_invoice', 'customer_payment_to_refund') and application."status" = 'applied'
      and application."currency_code" = $4
  ) apps on true
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" = 'customer_payment' and document."currency_code" = $4
    and document."document_date" between $5::date and $6::date
), filtered_rows as (
  select * from payment_rows where $7::text = 'all'
    or ($7::text = 'automatic' and "matching_mode" = 'automatic')
    or ($7::text = 'manual' and "matching_mode" = 'manual')
    or ($7::text = 'unapplied' and "open_amount" > 0)
)
select payment.*, payment."document_date"::text as "document_date", (${ordering.expression})::text as "sort_key"
from filtered_rows payment
where true
${boundarySql}
order by ${ordering.expression} ${ordering.direction} nulls ${ordering.nulls}, payment."payment_id" ${ordering.direction}
limit $${String(parameters.length)}`,
      parameters
    );
    const selectedRows = result.rows.slice(0, input.limit);
    if (traversal === "backward") selectedRows.reverse();
    const paymentIds = selectedRows.map((row) => string(row.payment_id, "payment_id"));
    const applications = paymentIds.length === 0
      ? []
      : (await client.query(
        `select application."subledger_application_id" as "application_id", application."source_id",
  application."application_type", application."status", application."version", application."application_date"::text as "application_date",
  application."source_document_id" as "source_payment_id", application."target_document_id",
  application."applied_amount", application."currency_code", application."applied_event_id", application."ended_event_id",
  application."match_candidate_id", application."match_decision_id", application."match_method", application."match_score",
  application."match_evidence", invoice."document_number" as "target_document_number",
  invoice."version" as "target_document_version"
from "erp_financials"."subledger_applications" application
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = application."tenant_id" and source."company_id" = application."company_id"
 and source."book_id" = $3 and source."source_id" = application."source_id"
 and (source."effective_from" is null or source."effective_from" <= application."application_date")
 and (source."effective_through" is null or source."effective_through" >= application."application_date")
join "erp_financials"."subledger_documents" invoice
  on invoice."tenant_id" = application."tenant_id" and invoice."company_id" = application."company_id"
 and invoice."source_id" = application."source_id" and invoice."subledger_document_id" = application."target_document_id"
 and invoice."document_type" = 'invoice' and invoice."currency_code" = $4
where application."tenant_id" = $1 and application."company_id" = $2
  and application."application_type" = 'customer_payment_to_invoice' and application."status" = 'applied'
  and application."currency_code" = $4 and application."source_document_id" = any($5::text[])
order by application."source_document_id" collate "C", application."application_date",
  application."subledger_application_id" collate "C"`,
        [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, paymentIds]
      )).rows;
    const applicationsByPayment = new Map<string, CustomerPaymentRegisterApplication[]>();
    for (const row of applications) {
      const application = customerPaymentRegisterApplicationFromRow(row);
      const list = applicationsByPayment.get(application.sourcePaymentId) ?? [];
      list.push(application);
      applicationsByPayment.set(application.sourcePaymentId, list);
    }
    const items = selectedRows.map((row) => {
      const paymentId = string(row.payment_id, "payment_id");
      return customerPaymentRegisterRowFromRow(row, applicationsByPayment.get(paymentId) ?? [], input.sort);
    });
    const totals = await client.query(
      `with payment_rows as (
  select document."original_amount", document."open_amount", document."status",
    coalesce(sum(application."applied_amount") filter (where application."application_type" = 'customer_payment_to_refund'), 0) as "returned_amount",
    case when bool_or(application."match_method" = 'automatic') filter (where application."application_type" = 'customer_payment_to_invoice') then 'automatic'
      when count(application."subledger_application_id") filter (where application."application_type" = 'customer_payment_to_invoice') > 0 then 'manual' else 'unmatched' end as "matching_mode"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join "erp_financials"."subledger_applications" application
    on application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
   and application."source_id" = document."source_id" and application."source_document_id" = document."subledger_document_id"
   and application."application_type" in ('customer_payment_to_invoice', 'customer_payment_to_refund') and application."status" = 'applied'
   and application."currency_code" = $4
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" = 'customer_payment' and document."currency_code" = $4
    and document."document_date" between $5::date and $6::date
  group by document."subledger_document_id"
)
select coalesce(sum("original_amount"), 0.0000::numeric) as "received_amount", count(*)::integer as "received_count",
  coalesce(sum("returned_amount"), 0) as "returned_amount",
  coalesce(sum(case when "status" = 'voided' then 0 else "original_amount" - "returned_amount" end), 0) as "retained_amount",
  coalesce(sum("open_amount") filter (where "open_amount" > 0), 0.0000::numeric) as "unapplied_amount",
  count(*) filter (where "open_amount" > 0)::integer as "unapplied_count",
  count(*) filter (where "matching_mode" = 'automatic')::integer as "automatic_count",
  count(*) filter (where "matching_mode" <> 'unmatched')::integer as "matched_count",
  coalesce(sum("original_amount") filter (where $7::text = 'all'
    or ($7::text = 'automatic' and "matching_mode" = 'automatic')
    or ($7::text = 'manual' and "matching_mode" = 'manual')
    or ($7::text = 'unapplied' and "open_amount" > 0)), 0.0000::numeric) as "filtered_amount",
  count(*) filter (where $7::text = 'all'
    or ($7::text = 'automatic' and "matching_mode" = 'automatic')
    or ($7::text = 'manual' and "matching_mode" = 'manual')
    or ($7::text = 'unapplied' and "open_amount" > 0))::integer as "filtered_count"
from payment_rows`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.periodStart, input.periodEnd, filter]
    );
    const totalRow = requiredRow(totals.rows[0], "customer payment register totals");
    const hasMore = result.rows.length > input.limit;
    const hasPrevious = items.length > 0 && (traversal === "backward" ? hasMore : boundary !== undefined);
    const hasNext = items.length > 0 && (traversal === "forward" ? hasMore : boundary !== undefined);
    const first = items[0];
    const last = items.at(-1);
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currencyCode: book.currencyCode,
      items,
      totalCount: integer(totalRow.filtered_count, "filtered_count"),
      filteredAmount: decimal(totalRow.filtered_amount, "filtered_amount"),
      totals: {
        receivedAmount: decimal(totalRow.received_amount, "received_amount"),
        returnedAmount: decimal(totalRow.returned_amount, "returned_amount"),
        retainedAmount: decimal(totalRow.retained_amount, "retained_amount"),
        receivedPaymentCount: integer(totalRow.received_count, "received_count"),
        unappliedAmount: decimal(totalRow.unapplied_amount, "unapplied_amount"),
        unappliedPaymentCount: integer(totalRow.unapplied_count, "unapplied_count"),
        automaticallyMatchedPaymentCount: integer(totalRow.automatic_count, "automatic_count"),
        matchedPaymentCount: integer(totalRow.matched_count, "matched_count")
      },
      hasPrevious,
      hasNext,
      ...(hasPrevious && first !== undefined
        ? { previousBoundary: customerPaymentRegisterBoundaryFor(first, input.sort, input.direction, "backward") }
        : {}),
      ...(hasNext && last !== undefined
        ? { nextBoundary: customerPaymentRegisterBoundaryFor(last, input.sort, input.direction, "forward") }
        : {})
    };
  });
}

function customerPaymentRegisterBoundary(
  value: CustomerPaymentRegisterBoundary | undefined,
  sort: CustomerPaymentRegisterSort,
  direction: CustomerPaymentRegisterDirection
): CustomerPaymentRegisterBoundary | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.sort !== sort || value.direction !== direction ||
      !CUSTOMER_PAYMENT_REGISTER_TRAVERSALS.has(value.traversal) ||
      typeof value.paymentId !== "string" || value.paymentId.trim().length === 0 ||
      (value.value !== null && typeof value.value !== "string")) {
    throw new ErpFinancialsError("invalid_input", "Customer payment register boundary does not match sort and direction");
  }
  if ((sort === "date" || sort === "amount" || sort === "method" || sort === "match") && value.value === null) {
    throw new ErpFinancialsError("invalid_input", "Customer payment register boundary value is invalid for sort");
  }
  if (sort === "date" && value.value !== null) assertDate(value.value, "boundary.value");
  if (sort === "amount" && !/^-?\d+(?:\.\d+)?$/u.test(value.value ?? "")) {
    throw new ErpFinancialsError("invalid_input", "boundary.value must be a decimal");
  }
  if (value.value !== null && value.value.length === 0) {
    throw new ErpFinancialsError("invalid_input", "Customer payment register boundary text must not be empty");
  }
  return value;
}

function customerPaymentRegisterOrdering(
  sort: CustomerPaymentRegisterSort,
  direction: CustomerPaymentRegisterDirection,
  traversal: "forward" | "backward"
): CustomerPaymentRegisterOrdering {
  const expressions: Record<CustomerPaymentRegisterSort, { expression: string; cast: "text" | "date" | "numeric" }> = {
    payment: { expression: 'payment."document_number" collate "C"', cast: "text" },
    customer: { expression: 'payment."party_name" collate "C"', cast: "text" },
    date: { expression: 'payment."document_date"', cast: "date" },
    method: { expression: 'payment."payment_method" collate "C"', cast: "text" },
    appliedTo: { expression: 'payment."applied_to" collate "C"', cast: "text" },
    match: { expression: 'payment."match_label" collate "C"', cast: "text" },
    amount: { expression: 'payment."original_amount"', cast: "numeric" }
  };
  const reversed = traversal === "backward";
  return {
    ...expressions[sort],
    direction: reversed ? (direction === "asc" ? "desc" : "asc") : direction,
    nulls: reversed ? "first" : "last"
  };
}

function customerPaymentRegisterBoundarySql(ordering: CustomerPaymentRegisterOrdering, boundaryIsNull: boolean): string {
  const comparison = ordering.direction === "asc" ? ">" : "<";
  const idComparison = `payment."payment_id" ${comparison} $9::text`;
  if (boundaryIsNull) {
    return ordering.nulls === "first"
      ? `  and $8::text is null and (${ordering.expression} is not null or (${ordering.expression} is null and ${idComparison}))`
      : `  and $8::text is null and ${ordering.expression} is null and ${idComparison}`;
  }
  const parameter = ordering.cast === "text" ? '($8::text collate "C")' : `$8::${ordering.cast}`;
  const comparisonSql = `${ordering.expression} ${comparison} ${parameter} or (${ordering.expression} = ${parameter} and ${idComparison})`;
  return ordering.nulls === "last"
    ? `  and ((${ordering.expression} is not null and (${comparisonSql})) or ${ordering.expression} is null)`
    : `  and ${ordering.expression} is not null and (${comparisonSql})`;
}

function customerPaymentRegisterApplicationFromRow(
  row: Record<string, unknown>
): CustomerPaymentRegisterApplication {
  const targetDocumentNumber = optionalString(row.target_document_number);
  return {
    ...paymentApplicationFromRow(row),
    ...(targetDocumentNumber === undefined ? {} : { targetDocumentNumber }),
    targetDocumentVersion: integer(row.target_document_version, "target_document_version")
  };
}

function customerPaymentRegisterRowFromRow(
  row: Record<string, unknown>,
  applications: readonly CustomerPaymentRegisterApplication[],
  sort: CustomerPaymentRegisterSort
): CustomerPaymentRegisterRow {
  const match = optionalString(row.match_label);
  const paymentMethod = optionalString(row.payment_method);
  return {
    ...paymentFromRow(row),
    applications,
    sortValue: customerPaymentRegisterSortValue(row, sort),
    matchingMode: string(row.matching_mode, "matching_mode") as CustomerPaymentRegisterRow["matchingMode"],
    ...(match === undefined ? {} : { match }),
    ...(paymentMethod === undefined ? {} : { paymentMethod })
  };
}

function customerPaymentRegisterSortValue(row: Record<string, unknown>, sort: CustomerPaymentRegisterSort): string | null {
  if (row.sort_key === null || row.sort_key === undefined) return null;
  if (sort === "date") return date(row.sort_key, "sort_key");
  if (sort === "amount") return decimal(row.sort_key, "sort_key");
  return string(row.sort_key, "sort_key");
}

function customerPaymentRegisterBoundaryFor(
  item: CustomerPaymentRegisterRow,
  sort: CustomerPaymentRegisterSort,
  direction: CustomerPaymentRegisterDirection,
  traversal: "forward" | "backward"
): CustomerPaymentRegisterBoundary {
  return { sort, direction, traversal, value: item.sortValue, paymentId: item.paymentId };
}

// Filter membership first; enrich only the selected page. Refund-status filters
// require evidence before LIMIT. Database application-balance invariants mean
// a fully returned payment has zero open amount; partial/unapplied filters can
// use exact stored balances without a refund subquery for each candidate.
async function listPayments(
  scope: Scope,
  input: PageRequest & {
    readonly paymentType?: PaymentListItem["paymentType"];
    readonly vendorId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly status?: PaymentStatus;
    readonly paymentId?: string;
  }
): Promise<Page<PaymentListItem>> {
  const page = pageInput(input, "payments", scope.bookId);
  if (input.vendorId !== undefined) assertNonEmpty(input.vendorId, "vendorId");
  if (input.periodStart !== undefined) assertDate(input.periodStart, "periodStart");
  if (input.periodEnd !== undefined) assertDate(input.periodEnd, "periodEnd");
  if (input.periodStart !== undefined && input.periodEnd !== undefined) {
    assertWindow(input.periodStart, input.periodEnd);
  }
  if (input.status !== undefined && !PAYMENT_STATUSES.has(input.status)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported payment status ${input.status}`);
  }
  if (input.paymentId !== undefined) assertNonEmpty(input.paymentId, "paymentId");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with payment_page as materialized (
select document.*
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
where document."tenant_id" = $1 and document."company_id" = $2
  and document."document_type" in ('customer_payment', 'bill_payment') and document."currency_code" = $4
  and ($5::text is null or document."document_type" = $5)
  and ($6::text is null or (document."document_type" = 'bill_payment' and document."party_id" = $6))
  and ($7::date is null or document."document_date" >= $7::date)
  and ($8::date is null or document."document_date" <= $8::date)
  and ($12::text is null or document."subledger_document_id" = $12)
  and ($10::date is null or (document."document_date",document."subledger_document_id") < ($10::date,$11::text))
  and ($9::text is null${input.status === undefined ? "" : input.status === "voided" ? ` or document."status"='voided'`
    : input.status === "partial" ? ` or (document."status"<>'voided' and document."open_amount">0 and document."open_amount"<document."original_amount")`
    : input.status === "unapplied" ? ` or (document."status"<>'voided' and document."open_amount"=document."original_amount")`
    : ` or (document."status"<>'voided' and document."open_amount"=0 and
      coalesce((select sum(refund."applied_amount") from "erp_financials"."subledger_applications" refund
        where refund."tenant_id"=document."tenant_id" and refund."company_id"=document."company_id"
          and refund."source_id"=document."source_id" and refund."source_document_id"=document."subledger_document_id"
          and refund."status"='applied' and refund."application_type"='customer_payment_to_refund'),0)
      ${input.status === "returned" ? "=" : "<>"}document."original_amount")`})
order by document."document_date" desc,document."subledger_document_id" desc
limit $13
)
select document."subledger_document_id" as "payment_id",document."source_id",document."document_type",
  document."transaction_id",document."party_id",party."display_name" as "party_name",document."document_number",
  document."document_date"::text as "document_date",document."currency_code",document."original_amount",document."open_amount",
  document."version",document."lifecycle_event_id",
  case when document."document_type"='customer_payment' then document."metadata"->>'collectionRef' end as "collection_ref",
  case when document."status"='voided' then 'voided'
    when applications."returned_amount"=document."original_amount" then 'returned'
    when document."open_amount"=0 then 'applied'
    when document."open_amount"=document."original_amount" then 'unapplied'
    else 'partial' end as "payment_status",
  applications."returned_amount",applications."application_count"
from payment_page document
left join "erp_financials"."parties" party
 on party."tenant_id"=document."tenant_id" and party."source_id"=document."source_id" and party."party_id"=document."party_id"
cross join lateral (
 select coalesce(sum(application."applied_amount") filter(where application."application_type"='customer_payment_to_refund'),0) as "returned_amount",
  count(*) filter(where application."application_type" in ('customer_payment_to_invoice','bill_payment_to_bill'))::integer as "application_count"
 from "erp_financials"."subledger_applications" application
 where application."tenant_id"=document."tenant_id" and application."company_id"=document."company_id"
  and application."source_id"=document."source_id" and application."source_document_id"=document."subledger_document_id"
  and application."status"='applied'
) applications
order by document."document_date" desc,document."subledger_document_id" desc`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        book.currencyCode,
        input.paymentType,
        input.vendorId,
        input.periodStart,
        input.periodEnd,
        input.status,
        page.date,
        page.id,
        input.paymentId,
        page.limit + 1
      ]
    );
    return toPage(result.rows.map(paymentFromRow), page.limit, "payments", scope.bookId, (item) => ({
      date: item.paymentDate,
      id: item.paymentId
    }));
  });
}

// Application counts do not affect membership; materialize the page before them.
async function listBillPayments(
  scope: Scope,
  input: PageRequest & {
    readonly vendorId?: string;
    readonly periodStart?: IsoDate;
    readonly periodEnd?: IsoDate;
    readonly status?: BillPaymentLifecycleStatus;
    readonly paymentMethod?: BillPaymentMethod;
    readonly paymentId?: string;
  }
): Promise<Page<BillPaymentListItem>> {
  const page = pageInput(input, "bill-payments", scope.bookId);
  assertBillPaymentFilters(input);
  if (input.paymentId !== undefined) assertNonEmpty(input.paymentId, "paymentId");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with disbursement_candidates as materialized (
 select d.* from "erp_financials"."bill_payment_disbursements" d
 where d."tenant_id"=$1 and d."company_id"=$2 and d."currency_code"=$4
  and ($5::text is null or d."vendor_id"=$5)
  and ($6::date is null or d."payment_date">=$6::date)
  and ($7::date is null or d."payment_date"<=$7::date)
  and ($8::text is null or d."status"=$8)
  and ($9::text is null or d."payment_method"=$9)
  and ($12::text is null or d."bill_payment_id"=$12)
  and ($10::date is null or (d."payment_date",d."bill_payment_id")<($10::date,$11::text))
  and exists(select 1 from "erp_financials"."reporting_book_sources" s
   where s."tenant_id"=d."tenant_id" and s."company_id"=d."company_id" and s."book_id"=$3 and s."source_id"=d."source_id"
    and (s."effective_from" is null or s."effective_from"<=d."payment_date")
    and (s."effective_through" is null or s."effective_through">=d."payment_date"))
 order by d."payment_date" desc,d."bill_payment_id" desc limit $13
), document_candidates as materialized (
 select d.* from "erp_financials"."subledger_documents" d
 where d."tenant_id"=$1 and d."company_id"=$2 and d."currency_code"=$4 and d."document_type"='bill_payment'
  and ($5::text is null or d."party_id"=$5)
  and ($6::date is null or d."document_date">=$6::date)
  and ($7::date is null or d."document_date"<=$7::date)
  and ($8::text is null or (case when d."status"='voided' then 'voided' else 'cleared' end)=$8)
  and ($9::text is null or d."metadata" #>> '{billPaymentProvenance,paymentMethod}'=$9)
  and ($12::text is null or d."subledger_document_id"=$12)
  and ($10::date is null or (d."document_date",d."subledger_document_id")<($10::date,$11::text))
  and exists(select 1 from "erp_financials"."reporting_book_sources" s
   where s."tenant_id"=d."tenant_id" and s."company_id"=d."company_id" and s."book_id"=$3 and s."source_id"=d."source_id"
    and (s."effective_from" is null or s."effective_from"<=coalesce(d."recognition_date",d."document_date"))
    and (s."effective_through" is null or s."effective_through">=coalesce(d."recognition_date",d."document_date")))
  and not exists(select 1 from "erp_financials"."bill_payment_disbursements" b
   where b."tenant_id"=d."tenant_id" and b."company_id"=d."company_id" and b."source_id"=d."source_id" and b."bill_payment_id"=d."subledger_document_id")
 order by d."document_date" desc,d."subledger_document_id" desc limit $13
), canonical_bill_payments as (
select disbursement."bill_payment_id" as "payment_id", disbursement."source_id", disbursement."vendor_id",
  party."display_name" as "vendor_name", disbursement."document_number", disbursement."payment_date",
  disbursement."currency_code", disbursement."amount", disbursement."status", disbursement."version",
  disbursement."payment_method", disbursement."payment_reference", disbursement."funding_account_id",
  disbursement."payable_account_id", document."open_amount" as "unapplied_amount",
  coalesce(disbursement."voided_event_id", disbursement."cleared_event_id", disbursement."scheduled_event_id") as "lifecycle_event_id",
  document."transaction_id", document."version" as "document_version",
  case when document."subledger_document_id" is null then null
    when document."status" = 'voided' then 'voided'
    when document."open_amount" = 0 then 'applied'
    when document."open_amount" = document."original_amount" then 'unapplied'
    else 'partial' end as "application_status"
from disbursement_candidates disbursement
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = disbursement."tenant_id" and source."company_id" = disbursement."company_id"
 and source."book_id" = $3 and source."source_id" = disbursement."source_id"
 and (source."effective_from" is null or source."effective_from" <= disbursement."payment_date")
 and (source."effective_through" is null or source."effective_through" >= disbursement."payment_date")
left join "erp_financials"."subledger_documents" document
  on document."tenant_id" = disbursement."tenant_id" and document."company_id" = disbursement."company_id"
 and document."source_id" = disbursement."source_id" and document."subledger_document_id" = disbursement."subledger_document_id"
left join "erp_financials"."parties" party
  on party."tenant_id" = disbursement."tenant_id" and party."source_id" = disbursement."source_id"
 and party."party_id" = disbursement."vendor_id"
where disbursement."tenant_id" = $1 and disbursement."company_id" = $2 and disbursement."currency_code" = $4
union all
select document."subledger_document_id", document."source_id", document."party_id", party."display_name",
  document."document_number", document."document_date", document."currency_code", document."original_amount",
  case when document."status" = 'voided' then 'voided' else 'cleared' end, document."version",
  document."metadata" #>> '{billPaymentProvenance,paymentMethod}',
  document."metadata" #>> '{billPaymentProvenance,reference}',
  document."metadata" #>> '{billPaymentProvenance,fundingAccountId}',
  document."metadata" #>> '{billPaymentProvenance,payableAccountId}',
  document."open_amount", document."lifecycle_event_id", document."transaction_id", document."version",
  case when document."status" = 'voided' then 'voided'
    when document."open_amount" = 0 then 'applied'
    when document."open_amount" = document."original_amount" then 'unapplied'
    else 'partial' end
from document_candidates document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
left join "erp_financials"."parties" party
  on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id" and party."party_id" = document."party_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'bill_payment'
  and document."currency_code" = $4 and not exists (
    select 1 from "erp_financials"."bill_payment_disbursements" disbursement
    where disbursement."tenant_id" = document."tenant_id" and disbursement."company_id" = document."company_id"
      and disbursement."source_id" = document."source_id" and disbursement."bill_payment_id" = document."subledger_document_id"
  )
), payment_page as materialized (
select * from canonical_bill_payments
where ($5::text is null or "vendor_id" = $5)
  and ($6::date is null or "payment_date" >= $6::date)
  and ($7::date is null or "payment_date" <= $7::date)
  and ($8::text is null or "status" = $8)
  and ($9::text is null or "payment_method" = $9)
  and ($12::text is null or "payment_id" = $12)
  and ($10::date is null or ("payment_date", "payment_id") < ($10::date, $11::text))
order by canonical_bill_payments."payment_date" desc, "payment_id" desc
limit $13
)
select payment_page.*, payment_page."payment_date"::text as "payment_date", applications."application_count"
from payment_page
cross join lateral (
 select count(*)::integer as "application_count" from "erp_financials"."subledger_applications" application
 where application."tenant_id"=$1 and application."company_id"=$2
  and application."source_id"=payment_page."source_id" and application."source_document_id"=payment_page."payment_id"
  and application."status"='applied'
) applications
order by payment_page."payment_date" desc, payment_page."payment_id" desc`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        book.currencyCode,
        input.vendorId,
        input.periodStart,
        input.periodEnd,
        input.status,
        input.paymentMethod,
        page.date,
        page.id,
        input.paymentId,
        page.limit + 1
      ]
    );
    return toPage(result.rows.map(billPaymentFromRow), page.limit, "bill-payments", scope.bookId, (item) => ({
      date: item.paymentDate,
      id: item.paymentId
    }));
  });
}

function assertBillPaymentFilters(input: {
  readonly vendorId?: string;
  readonly periodStart?: IsoDate;
  readonly periodEnd?: IsoDate;
  readonly status?: BillPaymentLifecycleStatus;
  readonly paymentMethod?: BillPaymentMethod;
}): void {
  if (input.vendorId !== undefined) assertNonEmpty(input.vendorId, "vendorId");
  if (input.periodStart !== undefined) assertDate(input.periodStart, "periodStart");
  if (input.periodEnd !== undefined) assertDate(input.periodEnd, "periodEnd");
  if (input.periodStart !== undefined && input.periodEnd !== undefined) {
    assertWindow(input.periodStart, input.periodEnd);
  }
  if (input.status !== undefined && !BILL_PAYMENT_LIFECYCLE_STATUSES.has(input.status)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported bill payment status ${input.status}`);
  }
  if (input.paymentMethod !== undefined && !BILL_PAYMENT_METHODS.has(input.paymentMethod)) {
    throw new ErpFinancialsError("invalid_input", `Unsupported bill payment method ${input.paymentMethod}`);
  }
}

/** One snapshot covers the payment, all active application revisions, controls and
 * a bounded page. Ended history never enters the review or its revision token. */
export async function getBillPaymentCorrectionReview(scope: Scope, request: BillPaymentCorrectionReviewRequest): Promise<BillPaymentCorrectionReviewPage> {
  const input = structuredClone(request);
  assertNonEmpty(input.sourceId, "sourceId"); assertNonEmpty(input.paymentId, "paymentId");
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "bill-payment-correction-review", scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.paymentId])).digest("hex");
  let boundaryDate: string | undefined, boundaryId: string | undefined, priorReview: string | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try { if (input.cursor.length > 4096) throw new Error(); cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new ErpFinancialsError("invalid_input", "Payment correction cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "bill-payment-correction-review" || cursor.scope !== fingerprint
      || typeof cursor.date !== "string" || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 1000
      || typeof cursor.review !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.review)) throw new ErpFinancialsError("invalid_input", "Payment correction cursor does not belong to this scope");
    assertDate(cursor.date, "cursor.date"); boundaryDate = cursor.date; boundaryId = cursor.id; priorReview = cursor.review;
  }
  return scope.database.transaction(async client => {
    const result = await client.query(`with candidates as materialized (
select coalesce(i.bill_payment_id,d.subledger_document_id) as payment_id,
 coalesce(i.tenant_id,d.tenant_id) as tenant_id,coalesce(i.company_id,d.company_id) as company_id,coalesce(i.source_id,d.source_id) as source_id,
 coalesce(i.vendor_id,d.party_id) as vendor_id,coalesce(i.payment_date,d.document_date) as payment_date,
 coalesce(i.currency_code,d.currency_code) as currency_code,coalesce(i.amount,d.original_amount) as amount,
 coalesce(i.status,case when d.status='voided' then 'voided' else 'cleared' end) as status,
 coalesce(i.version,d.version) as version,d.version as document_version,d.open_amount as unapplied_amount,
 coalesce(i.document_number,d.document_number) as document_number,
 coalesce(i.payment_reference,d.metadata #>> '{billPaymentProvenance,reference}') as reference,
 coalesce(i.payment_method,d.metadata #>> '{billPaymentProvenance,paymentMethod}') as payment_method,
 coalesce(i.funding_account_id,d.metadata #>> '{billPaymentProvenance,fundingAccountId}') as funding_account_id,
 coalesce(i.payable_account_id,d.metadata #>> '{billPaymentProvenance,payableAccountId}') as payable_account_id,
 case when i.bill_payment_id is not null then scheduled.book_id else posted.book_id end as owner_book,
 (d.subledger_document_id is null or (d.document_type='bill_payment' and posted.book_id=$3)) as native_document
from (select * from erp_financials.bill_payment_disbursements where tenant_id=$1 and company_id=$2 and source_id=$4 and bill_payment_id=$5) i
full join (select * from erp_financials.subledger_documents where tenant_id=$1 and company_id=$2 and source_id=$4 and subledger_document_id=$5) d
 on d.tenant_id=i.tenant_id and d.company_id=i.company_id and d.source_id=i.source_id and d.subledger_document_id=i.bill_payment_id
left join erp_financials.financial_outbox scheduled on scheduled.tenant_id=i.tenant_id and scheduled.company_id=i.company_id and scheduled.source_id=i.source_id
 and scheduled.aggregate_id=i.bill_payment_id and scheduled.event_type='bill_payment.scheduled' and scheduled.idempotency_key='bill-payment:'||i.idempotency_key||':outbox:scheduled'
left join erp_financials.financial_outbox posted on posted.tenant_id=d.tenant_id and posted.company_id=d.company_id and posted.source_id=d.source_id
 and posted.aggregate_id=d.transaction_id and posted.event_type='ledger.posted' and posted.idempotency_key='ledger-posted:Subledger:bill_payment:'||d.idempotency_key
), payment as materialized (
select c.* from candidates c
join erp_financials.reporting_books b on b.tenant_id=c.tenant_id and b.company_id=c.company_id and b.book_id=$3 and b.status='active' and b.base_currency_code=c.currency_code
join erp_financials.reporting_book_sources bs on bs.tenant_id=c.tenant_id and bs.company_id=c.company_id and bs.book_id=b.book_id and bs.source_id=c.source_id
 and (bs.effective_from is null or bs.effective_from<=c.payment_date) and (bs.effective_through is null or bs.effective_through>=c.payment_date)
where c.owner_book=$3 and c.native_document
), active as materialized (
select a.subledger_application_id as application_id,a.version,a.application_date,a.applied_amount,a.target_document_id as bill_id,
 d.version as bill_version,d.document_number as bill_number,d.original_amount as bill_amount,d.open_amount as bill_open_amount,
 d.status as bill_status,d.payment_hold as bill_payment_hold,
 (a.application_type='bill_payment_to_bill' and d.document_type='vendor_bill' and d.party_id=p.vendor_id and d.currency_code=p.currency_code
  and evidence.book_id=$3) as supported
from payment p join erp_financials.subledger_applications a on a.tenant_id=p.tenant_id and a.company_id=p.company_id and a.source_id=p.source_id
 and a.source_document_id=p.payment_id and a.status='applied'
left join erp_financials.subledger_documents d on d.tenant_id=a.tenant_id and d.company_id=a.company_id and d.source_id=a.source_id and d.subledger_document_id=a.target_document_id
left join erp_financials.financial_outbox evidence on evidence.tenant_id=d.tenant_id and evidence.company_id=d.company_id and evidence.source_id=d.source_id
 and evidence.aggregate_id=d.transaction_id and evidence.event_type='ledger.posted' and evidence.idempotency_key='ledger-posted:Subledger:vendor_bill:'||d.idempotency_key
), controls as (
select count(*)::text as active_count,coalesce(sum(applied_amount),0)::text as applied_amount,
 coalesce(bool_and(coalesce(supported,false)),true) as supported,
 md5(coalesce(string_agg(jsonb_build_array(application_id,version,application_date,applied_amount::text,bill_id,bill_version,
 bill_number,bill_amount::text,bill_open_amount::text,bill_status,bill_payment_hold,supported)::text,',' order by application_id),'')) as revision from active
), page as (
select * from active where ($6::date is null or (application_date,application_id)>($6::date,$7::text)) order by application_date,application_id limit $8
)
select jsonb_build_object('paymentId',p.payment_id,'sourceId',p.source_id,'vendorId',p.vendor_id,'date',p.payment_date::text,
 'currencyCode',p.currency_code,'amount',p.amount::text,'status',p.status,'version',p.version,'documentVersion',p.document_version,
 'unappliedAmount',p.unapplied_amount::text,'documentNumber',p.document_number,'reference',p.reference,'paymentMethod',p.payment_method,
 'fundingAccountId',p.funding_account_id,'payableAccountId',p.payable_account_id) as payment,
 controls.active_count,controls.applied_amount,controls.supported,controls.revision,
 coalesce((select jsonb_agg(jsonb_build_object('applicationId',application_id,'version',version,'date',application_date::text,'amount',applied_amount::text,
 'billId',bill_id,'billVersion',bill_version,'billNumber',bill_number,'billAmount',bill_amount::text,'billOpenAmount',bill_open_amount::text,
 'billStatus',bill_status,'billPaymentHold',bill_payment_hold) order by application_date,application_id) from page),'[]'::jsonb) as items
from payment p cross join controls`, [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.paymentId, boundaryDate, boundaryId, limit+1]);
    const row = result.rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Native payment is not available in this correction scope");
    if (row.supported !== true) throw new ErpFinancialsError("unsupported_operation", "Payment applications require native bills in the correction book");
    const header = jsonObject(row.payment, "payment");
    const status = string(header.status, "status");
    if (status === "voided") throw new ErpFinancialsError("terminal_state_conflict", "A voided payment cannot be reviewed for another correction");
    if (status !== "scheduled" && status !== "cleared") throw new ErpFinancialsError("invalid_input", "Invalid stored payment status");
    const payment: BillPaymentCorrectionReviewPage["payment"] = {
      paymentId: string(header.paymentId,"paymentId"), sourceId: string(header.sourceId,"sourceId"), vendorId: string(header.vendorId,"vendorId"),
      date: date(header.date,"date"), currencyCode: string(header.currencyCode,"currencyCode"), amount: money(header.amount,"amount"), status,
      version: integer(header.version,"version"), documentVersion: optionalInteger(header.documentVersion,"documentVersion") ?? null,
      unappliedAmount: header.unappliedAmount === null ? null : money(header.unappliedAmount,"unappliedAmount"),
      documentNumber: optionalString(header.documentNumber) ?? null, reference: optionalString(header.reference) ?? null,
      paymentMethod: optionalString(header.paymentMethod) ?? null, fundingAccountId: optionalString(header.fundingAccountId) ?? null,
      payableAccountId: optionalString(header.payableAccountId) ?? null
    };
    const reviewToken = createHash("sha256").update(JSON.stringify([fingerprint,payment,row.revision])).digest("hex");
    if (priorReview !== undefined && priorReview !== reviewToken) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Payment correction review changed; restart from the first page", { retryable:true });
    const values: unknown = row.items;
    if (!Array.isArray(values)) throw new ErpFinancialsError("invalid_input", "Invalid stored payment review page");
    const items = values.slice(0,limit).map((value: unknown): BillPaymentCorrectionReviewApplication => {
      const item = jsonObject(value,"application");
      return { applicationId:string(item.applicationId,"applicationId"), version:integer(item.version,"version"), date:date(item.date,"date"), amount:money(item.amount,"amount"),
        billId:string(item.billId,"billId"), billVersion:integer(item.billVersion,"billVersion"), billNumber:optionalString(item.billNumber) ?? null,
        billAmount:money(item.billAmount,"billAmount"), billOpenAmount:money(item.billOpenAmount,"billOpenAmount"), billStatus:string(item.billStatus,"billStatus"), billPaymentHold:item.billPaymentHold===true };
    });
    const last=items.at(-1);
    return {payment,reviewToken,activeApplicationCount:string(row.active_count,"active_count"),appliedAmount:money(row.applied_amount,"applied_amount"),items,
      ...(values.length>limit && last ? {nextCursor:Buffer.from(JSON.stringify({v:1,kind:"bill-payment-correction-review",scope:fingerprint,review:reviewToken,date:last.date,id:last.applicationId})).toString("base64url")} : {})};
  });
}

async function findVendorBillHoldCommandByKey(scope: Scope, request: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<VendorBillHoldCommandReceipt | null> {
  const input = { sourceId: request.sourceId, idempotencyKey: request.idempotencyKey };
  for (const [field, value] of Object.entries(input)) assertNonEmpty(value, field);
  return scope.database.transaction(async client => {
    // Exact unique lifecycle key, with native posting-book provenance in the
    // same snapshot. Source membership alone must not expose another book's bill.
    const row = (await client.query(`select book.status as book_status, instruction.*
      from erp_financials.reporting_books book left join lateral (
        select event.event_id, event.aggregate_id, event.payload
        from erp_financials.financial_lifecycle_events event
        join erp_financials.subledger_documents bill on bill.tenant_id=event.tenant_id
          and bill.company_id=event.company_id and bill.source_id=event.source_id
          and bill.subledger_document_id=event.aggregate_id and bill.document_type='vendor_bill'
        join erp_financials.reporting_book_sources source on source.tenant_id=bill.tenant_id
          and source.company_id=bill.company_id and source.source_id=bill.source_id and source.book_id=book.book_id
          and (source.effective_from is null or source.effective_from<=coalesce(bill.recognition_date,bill.document_date))
          and (source.effective_through is null or source.effective_through>=coalesce(bill.recognition_date,bill.document_date))
        join erp_financials.financial_outbox origin on origin.tenant_id=bill.tenant_id
          and origin.company_id=bill.company_id and origin.source_id=bill.source_id and origin.book_id=book.book_id
          and origin.idempotency_key='ledger-posted:Subledger:vendor_bill:'||bill.idempotency_key
          and origin.event_type='ledger.posted' and origin.aggregate_id=bill.transaction_id
        where event.tenant_id=book.tenant_id and event.company_id=book.company_id
          and event.source_id=$4 and event.idempotency_key='vendor-bill-hold:'||$5
          and event.event_type='subledger.vendor_bill.payment_hold_changed' and event.aggregate_type='subledger_document'
          and bill.currency_code=book.base_currency_code and book.status='active' limit 1
      ) instruction on true where book.tenant_id=$1 and book.company_id=$2 and book.book_id=$3`,
      [scope.tenantId, scope.companyId, scope.bookId, input.sourceId, input.idempotencyKey])).rows[0];
    if (!row) throw new ErpFinancialsError("missing_book", "Reporting book does not exist in this scope");
    if (row.book_status !== "active") throw new ErpFinancialsError("terminal_state_conflict", "Reporting book is not active");
    if (row.event_id === null) return null;
    const payload = jsonObject(optionalJson(row.payload), "vendor bill hold command payload"), result = payload.result;
    if (typeof payload.commandChecksum !== "string" || !/^[a-f0-9]{64}$/.test(payload.commandChecksum)
      || typeof payload.expectedVersion !== "number" || !Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1
      || !isRecord(result) || result.vendorBillId !== row.aggregate_id || result.version !== payload.expectedVersion + 1
      || typeof result.paymentHold !== "boolean" || (result.paymentHoldReason !== null && typeof result.paymentHoldReason !== "string")
      || (result.paymentHold ? !result.paymentHoldReason : result.paymentHoldReason !== null)) {
      throw new ErpFinancialsError("invalid_input", "Retained vendor bill hold command evidence is invalid");
    }
    return { lifecycleEventId: string(row.event_id, "event_id"), sourceId: input.sourceId, idempotencyKey: input.idempotencyKey,
      vendorBillId: string(row.aggregate_id, "aggregate_id"), originalExpectedVersion: payload.expectedVersion,
      resultingVersion: result.version, paymentHold: result.paymentHold, reason: result.paymentHoldReason };
  });
}

async function findBankMatchCommandByKey(scope: Scope, request: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<BankMatchCommandReceipt | null> {
  const input={sourceId:request.sourceId,idempotencyKey:request.idempotencyKey};
  for(const [field,value] of Object.entries(input)) if(typeof value!=="string"||!value.trim()) throw new ErpFinancialsError("invalid_input",`${field} must be a nonempty string`);
  return scope.database.transaction(async client=>{
    // Unique key lookup and book eligibility share one statement snapshot.
    // Unmatching replaces match.lifecycle_event_id: locate the ORIGINAL event
    // by its retained command key instead, never the mutable lifecycle pointer.
    const row=(await client.query(`select book.status as book_status,instruction.*
      from erp_financials.reporting_books book
      left join lateral (
        select match.bank_reconciliation_match_id,match.bank_statement_line_id,match.transaction_id,
          match.method,match.status,match.version,match.matched_amount,event.payload
        from erp_financials.bank_reconciliation_matches match
        join erp_financials.bank_statement_lines line
          on line.tenant_id=match.tenant_id and line.company_id=match.company_id and line.source_id=match.source_id
          and line.book_id=match.book_id and line.bank_statement_line_id=match.bank_statement_line_id
        join erp_financials.reporting_book_sources source
          on source.tenant_id=match.tenant_id and source.company_id=match.company_id
          and source.source_id=match.source_id and source.book_id=book.book_id
          and (source.effective_from is null or source.effective_from<=line.posted_date)
          and (source.effective_through is null or source.effective_through>=line.posted_date)
        left join erp_financials.financial_lifecycle_events event
          on event.tenant_id=match.tenant_id and event.company_id=match.company_id and event.source_id=match.source_id
          and event.idempotency_key='bank-match:'||match.idempotency_key||':matched'
          and event.aggregate_type='bank_reconciliation_match' and event.aggregate_id=match.bank_reconciliation_match_id
          and event.event_type='bank_reconciliation.matched'
        where match.tenant_id=book.tenant_id and match.company_id=book.company_id and match.book_id=book.book_id
          and match.source_id=$4 and match.idempotency_key=$5 and line.currency_code=book.base_currency_code and book.status='active'
        limit 1
      ) instruction on true
      where book.tenant_id=$1 and book.company_id=$2 and book.book_id=$3`,[scope.tenantId,scope.companyId,scope.bookId,input.sourceId,input.idempotencyKey])).rows[0];
    if(!row)throw new ErpFinancialsError("missing_book","Reporting book does not exist in this scope");
    if(row.book_status!=="active")throw new ErpFinancialsError("terminal_state_conflict","Reporting book is not active");
    if(row.bank_reconciliation_match_id===null)return null;
    const payload=jsonObject(optionalJson(row.payload),"bank match command payload");
    if(payload.bankStatementLineId!==row.bank_statement_line_id||payload.transactionId!==row.transaction_id||payload.method!==row.method)throw new ErpFinancialsError("invalid_input","Retained bank match evidence is inconsistent");
    let originalExpectedVersion:number|null=null;
    if(payload.commandVersion!==undefined||payload.commandChecksum!==undefined||payload.expectedVersion!==undefined){
      if(payload.commandVersion!==1||typeof payload.commandChecksum!=="string"||!/^[a-f0-9]{64}$/.test(payload.commandChecksum)||typeof payload.expectedVersion!=="number"||!Number.isSafeInteger(payload.expectedVersion)||payload.expectedVersion<1)throw new ErpFinancialsError("invalid_input","Retained bank match version evidence is invalid");
      originalExpectedVersion=payload.expectedVersion;
    }
    if(!["matched","unmatched","voided"].includes(String(row.status))||!["automatic","manual"].includes(String(row.method)))throw new ErpFinancialsError("invalid_input","Retained bank match lifecycle is invalid");
    return {bankReconciliationMatchId:string(row.bank_reconciliation_match_id,"bank_reconciliation_match_id"),sourceId:input.sourceId,idempotencyKey:input.idempotencyKey,
      bankStatementLineId:string(row.bank_statement_line_id,"bank_statement_line_id"),transactionId:string(row.transaction_id,"transaction_id"),
      method:row.method as BankMatchCommandReceipt["method"],status:row.status as BankMatchCommandReceipt["status"],version:integer(row.version,"version"),matchedAmount:money(row.matched_amount,"matched_amount"),originalExpectedVersion};
  });
}

async function findBillPaymentCommandByKey(scope: Scope, request: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<BillPaymentCommandReceipt | null> {
  const input = {sourceId:request.sourceId,idempotencyKey:request.idempotencyKey};
  for (const [field,value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) throw new ErpFinancialsError("invalid_input", `${field} must be a nonempty string`);
  }
  return scope.database.transaction(async client => {
    // Book eligibility, provenance, current lifecycle and immutable instruction
    // share a single statement snapshot. The unique command-key index bounds
    // this read; no payment list or current application history is collected.
    const row = (await client.query(`select book.status as book_status,instruction.*
      from erp_financials.reporting_books book
      left join lateral (
        select payment.bill_payment_id,payment.source_id,payment.idempotency_key,payment.status,payment.version,payment.allocations
        from erp_financials.bill_payment_disbursements payment
        join erp_financials.reporting_book_sources source
          on source.tenant_id=payment.tenant_id and source.company_id=payment.company_id
          and source.source_id=payment.source_id and source.book_id=book.book_id
          and (source.effective_from is null or source.effective_from<=payment.payment_date)
          and (source.effective_through is null or source.effective_through>=payment.payment_date)
        where payment.tenant_id=book.tenant_id and payment.company_id=book.company_id
          and payment.source_id=$4 and payment.idempotency_key=$5 and payment.currency_code=book.base_currency_code
          and book.status='active' and exists (
            select 1 from erp_financials.financial_outbox evidence
            where evidence.tenant_id=payment.tenant_id and evidence.company_id=payment.company_id
              and evidence.source_id=payment.source_id and evidence.aggregate_id=payment.bill_payment_id
              and evidence.event_type='bill_payment.scheduled' and evidence.book_id=book.book_id
              and evidence.idempotency_key='bill-payment:'||payment.idempotency_key||':outbox:scheduled')
        limit 1
      ) instruction on true
      where book.tenant_id=$1 and book.company_id=$2 and book.book_id=$3`,
    [scope.tenantId,scope.companyId,scope.bookId,input.sourceId,input.idempotencyKey])).rows[0];
    if (!row) throw new ErpFinancialsError("missing_book", "Reporting book does not exist in this scope");
    if (row.book_status !== "active") throw new ErpFinancialsError("terminal_state_conflict", "Reporting book is not active");
    if (row.bill_payment_id === null) return null;
    const status=string(row.status,"status") as BillPaymentLifecycleStatus;
    if (!BILL_PAYMENT_LIFECYCLE_STATUSES.has(status)) throw new ErpFinancialsError("invalid_input", "Retained payment status is invalid");
    const raw=optionalJson(row.allocations);
    if (!Array.isArray(raw) || !raw.length) throw new ErpFinancialsError("invalid_input", "Retained payment allocations are missing");
    const allocations=raw.map(value=>{
      const allocation=jsonObject(value,"payment allocation"),billId=string(allocation.billId,"billId");
      const amount=money(allocation.amount,"amount"),expectedBillVersion=integer(allocation.expectedBillVersion,"expectedBillVersion");
      if (!Number.isSafeInteger(expectedBillVersion) || expectedBillVersion<1 || moneyMinor(amount)<=0n) throw new ErpFinancialsError("invalid_input", "Retained allocation evidence is invalid");
      return {billId,amount,expectedBillVersion};
    });
    return {paymentId:string(row.bill_payment_id,"bill_payment_id"),sourceId:input.sourceId,idempotencyKey:input.idempotencyKey,status,
      version:integer(row.version,"version"),allocations};
  });
}

async function getBillPayment(scope: Scope, paymentId: string): Promise<BillPaymentDetail> {
  assertNonEmpty(paymentId, "paymentId");
  const page = await listBillPayments(scope, { paymentId, limit: 1 });
  const payment = page.items[0];
  if (payment === undefined) {
    throw new ErpFinancialsError(
      "missing_document",
      `Bill payment ${paymentId} does not exist in reporting book ${scope.bookId}`,
      { details: { bookId: scope.bookId, paymentId } }
    );
  }
  return scope.database.transaction(async (client) => {
    const header = await client.query(
      `select coalesce(transaction."memo", disbursement."memo") as "memo", disbursement."allocations",
  scheduled."event_id" as "scheduled_event_id", scheduled."actor_ref" as "scheduled_actor_ref",
  scheduled."approver_ref" as "scheduled_approver_ref", scheduled."request_id" as "scheduled_request_id",
  scheduled."reason_code" as "scheduled_reason_code",
  cleared."event_id" as "cleared_event_id", cleared."actor_ref" as "cleared_actor_ref",
  cleared."approver_ref" as "cleared_approver_ref", cleared."request_id" as "cleared_request_id",
  cleared."reason_code" as "cleared_reason_code",
  posted."event_id" as "posted_event_id", posted."actor_ref" as "posted_actor_ref",
  posted."approver_ref" as "posted_approver_ref", posted."request_id" as "posted_request_id",
  posted."reason_code" as "posted_reason_code",
  voided."event_id" as "voided_event_id", voided."actor_ref" as "voided_actor_ref",
  voided."approver_ref" as "voided_approver_ref", voided."request_id" as "voided_request_id",
  voided."reason_code" as "voided_reason_code", void_link."related_transaction_id" as "reversal_transaction_id",
  coalesce(disbursement."funding_account_id", document."metadata" #>> '{billPaymentProvenance,fundingAccountId}') as "funding_account_id",
  funding_posting."posting_id" as "funding_posting_id", funding_posting."debit_amount" as "funding_debit_amount",
  funding_posting."credit_amount" as "funding_credit_amount",
  coalesce(disbursement."payable_account_id", document."metadata" #>> '{billPaymentProvenance,payableAccountId}') as "payable_account_id",
  payable_posting."posting_id" as "payable_posting_id", payable_posting."debit_amount" as "payable_debit_amount",
  payable_posting."credit_amount" as "payable_credit_amount"
from "erp_financials"."subledger_documents" document
full join "erp_financials"."bill_payment_disbursements" disbursement
  on disbursement."tenant_id" = document."tenant_id" and disbursement."company_id" = document."company_id"
 and disbursement."source_id" = document."source_id" and disbursement."bill_payment_id" = document."subledger_document_id"
left join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
left join "erp_financials"."financial_lifecycle_events" scheduled
  on scheduled."tenant_id" = disbursement."tenant_id" and scheduled."company_id" = disbursement."company_id"
 and scheduled."source_id" = disbursement."source_id" and scheduled."event_id" = disbursement."scheduled_event_id"
left join "erp_financials"."financial_lifecycle_events" cleared
  on cleared."tenant_id" = disbursement."tenant_id" and cleared."company_id" = disbursement."company_id"
 and cleared."source_id" = disbursement."source_id" and cleared."event_id" = disbursement."cleared_event_id"
left join "erp_financials"."financial_lifecycle_events" posted
  on posted."tenant_id" = document."tenant_id" and posted."company_id" = document."company_id"
 and posted."source_id" = document."source_id" and posted."event_id" = document."lifecycle_event_id"
left join lateral (
  select event."event_id", event."actor_ref", event."approver_ref", event."request_id", event."reason_code"
  from "erp_financials"."financial_lifecycle_events" event
  where event."tenant_id" = coalesce(disbursement."tenant_id", document."tenant_id")
    and event."company_id" = coalesce(disbursement."company_id", document."company_id")
    and event."source_id" = coalesce(disbursement."source_id", document."source_id")
    and (
      event."event_id" = disbursement."voided_event_id"
      or (disbursement."voided_event_id" is null and event."aggregate_type" = 'bill_payment'
        and event."aggregate_id" = document."subledger_document_id" and event."event_type" = 'bill_payment.voided')
    )
  order by event."occurred_at" desc, event."event_id" desc limit 1
) voided on true
left join lateral (
  select link."related_transaction_id"
  from "erp_financials"."journal_entry_links" link
  where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
    and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
    and link."link_type" = 'void'
  order by link."created_at" desc, link."journal_entry_link_id" desc limit 1
) void_link on true
left join lateral (
  select posting."posting_id", posting."debit_amount", posting."credit_amount"
  from "erp_financials"."ledger_postings" posting
  where posting."tenant_id" = document."tenant_id" and posting."source_id" = document."source_id"
    and posting."transaction_id" = document."transaction_id"
    and posting."account_id" = coalesce(disbursement."funding_account_id", document."metadata" #>> '{billPaymentProvenance,fundingAccountId}')
  order by posting."posting_id" limit 1
) funding_posting on true
left join lateral (
  select posting."posting_id", posting."debit_amount", posting."credit_amount"
  from "erp_financials"."ledger_postings" posting
  where posting."tenant_id" = document."tenant_id" and posting."source_id" = document."source_id"
    and posting."transaction_id" = document."transaction_id"
    and posting."account_id" = coalesce(disbursement."payable_account_id", document."metadata" #>> '{billPaymentProvenance,payableAccountId}')
  order by posting."posting_id" limit 1
) payable_posting on true
where coalesce(disbursement."tenant_id", document."tenant_id") = $1
  and coalesce(disbursement."company_id", document."company_id") = $2
  and coalesce(disbursement."source_id", document."source_id") = $3
  and coalesce(disbursement."bill_payment_id", document."subledger_document_id") = $4
  and (document."subledger_document_id" is null or document."document_type" = 'bill_payment')`,
      [scope.tenantId, scope.companyId, payment.sourceId, paymentId]
    );
    const row = requiredRow(header.rows[0], `bill payment ${paymentId}`);
    const reversalTransactionId = optionalString(row.reversal_transaction_id);
    const memo = optionalString(row.memo);
    const applications = orderBillPaymentApplications(
      await queryPaymentApplications(client, scope, { sourcePaymentId: paymentId }),
      row.allocations
    );
    const scheduled = optionalPrefixedLifecycleFromRow(row, "scheduled");
    const cleared = optionalPrefixedLifecycleFromRow(row, "cleared");
    const posted = optionalPrefixedLifecycleFromRow(row, "posted");
    const voided = optionalPrefixedLifecycleFromRow(row, "voided");
    const fundingAccount = accountEvidenceFromRow(row, "funding");
    const payableAccount = accountEvidenceFromRow(row, "payable");
    return {
      ...payment,
      ...(memo === undefined ? {} : { memo }),
      lifecycle: {
        ...(scheduled === undefined ? {} : { scheduled }),
        ...(cleared === undefined ? {} : { cleared }),
        ...(posted === undefined ? {} : { posted }),
        ...(voided === undefined ? {} : { voided }),
        ...(reversalTransactionId === undefined ? {} : { reversalTransactionId })
      },
      ...(fundingAccount === undefined ? {} : { fundingAccount }),
      ...(payableAccount === undefined ? {} : { payableAccount }),
      applications
    };
  });
}

async function getBillPaymentSummary(
  scope: Scope,
  input: {
    readonly periodStart: IsoDate;
    readonly periodEnd: IsoDate;
    readonly vendorId?: string;
    readonly status?: BillPaymentLifecycleStatus;
    readonly paymentMethod?: BillPaymentMethod;
  }
): Promise<BillPaymentSummary> {
  assertBillPaymentFilters(input);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with canonical_bill_payments as (
select disbursement."vendor_id", disbursement."payment_date", disbursement."amount", disbursement."status",
  disbursement."payment_method"
from "erp_financials"."bill_payment_disbursements" disbursement
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = disbursement."tenant_id" and source."company_id" = disbursement."company_id"
 and source."book_id" = $3 and source."source_id" = disbursement."source_id"
 and (source."effective_from" is null or source."effective_from" <= disbursement."payment_date")
 and (source."effective_through" is null or source."effective_through" >= disbursement."payment_date")
where disbursement."tenant_id" = $1 and disbursement."company_id" = $2 and disbursement."currency_code" = $4
union all
select document."party_id", document."document_date", document."original_amount",
  case when document."status" = 'voided' then 'voided' else 'cleared' end,
  document."metadata" #>> '{billPaymentProvenance,paymentMethod}'
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'bill_payment'
  and document."currency_code" = $4 and not exists (
    select 1 from "erp_financials"."bill_payment_disbursements" disbursement
    where disbursement."tenant_id" = document."tenant_id" and disbursement."company_id" = document."company_id"
      and disbursement."source_id" = document."source_id" and disbursement."bill_payment_id" = document."subledger_document_id"
  )
), filtered as (
  select * from canonical_bill_payments where "payment_date" between $5::date and $6::date
    and ($7::text is null or "vendor_id" = $7)
    and ($8::text is null or "status" = $8)
    and ($9::text is null or "payment_method" = $9)
)
select coalesce(sum("amount") filter (where "status" = 'scheduled'), 0)::numeric as "scheduled_amount",
  count(*) filter (where "status" = 'scheduled')::integer as "scheduled_count",
  coalesce(sum("amount") filter (where "status" = 'cleared'), 0)::numeric as "cleared_amount",
  count(*) filter (where "status" = 'cleared')::integer as "cleared_count",
  coalesce(sum("amount") filter (where "status" = 'voided'), 0)::numeric as "voided_amount",
  count(*) filter (where "status" = 'voided')::integer as "voided_count",
  coalesce(sum("amount"), 0)::numeric as "total_amount", count(*)::integer as "total_count"
from filtered`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        book.currencyCode,
        input.periodStart,
        input.periodEnd,
        input.vendorId,
        input.status,
        input.paymentMethod
      ]
    );
    const row = requiredRow(result.rows[0], "bill payment summary");
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currencyCode: book.currencyCode,
      scheduledAmount: money(row.scheduled_amount, "scheduled_amount"),
      scheduledCount: integer(row.scheduled_count, "scheduled_count"),
      clearedAmount: money(row.cleared_amount, "cleared_amount"),
      clearedCount: integer(row.cleared_count, "cleared_count"),
      voidedAmount: money(row.voided_amount, "voided_amount"),
      voidedCount: integer(row.voided_count, "voided_count"),
      totalAmount: money(row.total_amount, "total_amount"),
      totalCount: integer(row.total_count, "total_count")
    };
  });
}

async function getCustomerPayment(scope: Scope, paymentId: string, request: PageRequest): Promise<CustomerPaymentDetail> {
  assertNonEmpty(paymentId, "paymentId");
  const cursorKind = `receipt-applications:${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, paymentId])).digest("hex")}`;
  if (request.cursor !== undefined && request.cursor.length > 4096) throw new ErpFinancialsError("invalid_input", "Receipt application cursor is too large");
  const page = pageInput({ ...request, limit: request.limit ?? 100 }, cursorKind, scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with customer_payment_detail as (
select document."subledger_document_id" as "payment_id", document."source_id", document."document_type",
  document."transaction_id", document."party_id", party."display_name" as "party_name", document."document_number",
  document."document_date", document."currency_code", document."original_amount", document."open_amount",
  document."version", document."lifecycle_event_id", document."metadata", document."status" as "document_status", transaction."memo",
  document."created_at", document."updated_at", document."idempotency_key",
  creation."actor_ref", creation."approver_ref", creation."request_id", creation."reason_code",
  coalesce(sum(application."applied_amount") filter (where application."status" = 'applied'
    and application."application_type" = 'customer_payment_to_refund'), 0) as "returned_amount",
  count(application."subledger_application_id") filter (where application."status" = 'applied'
    and application."application_type" in ('customer_payment_to_invoice', 'bill_payment_to_bill'))::integer as "application_count"
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
left join "erp_financials"."financial_lifecycle_events" creation
  on creation."tenant_id" = document."tenant_id" and creation."company_id" = document."company_id"
 and creation."source_id" = document."source_id" and creation."event_id" = document."lifecycle_event_id"
left join "erp_financials"."parties" party
  on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id" and party."party_id" = document."party_id"
left join "erp_financials"."subledger_applications" application
  on application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
 and application."source_id" = document."source_id" and application."source_document_id" = document."subledger_document_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."subledger_document_id" = $4
  and document."document_type" = 'customer_payment' and document."currency_code" = $5
group by document."subledger_document_id", party."display_name", transaction."memo", creation."event_id"
)
select detail.*, detail."document_date"::text as "document_date", coalesce((
  select jsonb_agg(evidence order by evidence."application_date" desc,evidence."application_id" desc)
  from (
    select application."subledger_application_id" as "application_id",application."source_id",
      application."application_type",application."status",application."version",application."application_date",
      application."source_document_id" as "source_payment_id",application."target_document_id",
      application."applied_amount"::text as "applied_amount",application."currency_code",application."applied_event_id",application."ended_event_id",
      application."match_candidate_id",application."match_decision_id",application."match_method",
      application."match_score"::text as "match_score",application."match_evidence"
    from "erp_financials"."subledger_applications" application
    where application."tenant_id"=$1 and application."company_id"=$2
      and application."source_id"=detail."source_id" and application."source_document_id"=detail."payment_id"
      and ($6::date is null or (application."application_date",application."subledger_application_id")<($6::date,$7::text))
    order by application."application_date" desc,application."subledger_application_id" desc limit $8
  ) evidence
), '[]'::jsonb) as "application_rows"
from customer_payment_detail detail`,
      [scope.tenantId, scope.companyId, scope.bookId, paymentId, book.currencyCode, page.date, page.id, page.limit + 1]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ErpFinancialsError("missing_document", `Customer payment ${paymentId} does not exist in reporting book ${scope.bookId}`, {
        details: { bookId: scope.bookId, paymentId }
      });
    }
    const rawApplications = optionalJson(row.application_rows);
    if (!Array.isArray(rawApplications)) throw new Error("Stored receipt applications must be an array");
    const applications = toPage(rawApplications.map(value => paymentApplicationFromRow(jsonObject(value, "receipt application"))),
      page.limit, cursorKind, scope.bookId, item => ({ date: item.applicationDate, id: item.applicationId }));
    const item = paymentFromRow(row);
    const memo = optionalString(row.memo);
    const provenance = customerPaymentProvenanceFromMetadata(row.metadata);
    const metadata = optionalJson(row.metadata);
    const collectionRef = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? jsonObject(metadata, "receipt metadata").collectionRef : undefined;
    if (collectionRef !== undefined && (typeof collectionRef !== "string" || !collectionRef.trim() || collectionRef.length > 512)) throw new Error("Stored receipt collection reference is invalid");
    const cashFlowActivity = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? jsonObject(metadata, "receipt metadata").cashFlowActivity : undefined;
    if (cashFlowActivity !== undefined && cashFlowActivity !== "operating" && cashFlowActivity !== "investing" && cashFlowActivity !== "financing") throw new Error("Stored receipt cash-flow purpose is invalid");
    return {
      ...(collectionRef === undefined ? {} : { collectionRef }),
      ...(cashFlowActivity === undefined ? {} : { cashFlowActivity }),
      ...item,
      createdAt: isoDateTime(row.created_at, "created_at"),
      updatedAt: isoDateTime(row.updated_at, "updated_at"),
      idempotencyKey: string(row.idempotency_key, "idempotency_key"),
      ...(optionalString(row.actor_ref) === undefined ? {} : { creationLifecycle: lifecycleFromRow(row) }),
      transactionId: string(row.transaction_id, "transaction_id"),
      version: integer(row.version, "version"),
      lifecycleEventId: string(row.lifecycle_event_id, "lifecycle_event_id"),
      ...(memo === undefined ? {} : { memo }),
      ...(provenance === undefined ? {} : { provenance }),
      applications: applications.items,
      ...(applications.nextCursor ? { applicationsNextCursor: applications.nextCursor } : {})
    };
  });
}

async function listPaymentApplications(
  scope: Scope,
  input: PageRequest & {
    readonly applicationType?: PaymentApplicationListItem["applicationType"];
    readonly status?: PaymentApplicationListItem["status"];
    readonly sourcePaymentId?: string;
    readonly targetDocumentId?: string;
    readonly applicationId?: string;
  }
): Promise<Page<PaymentApplicationListItem>> {
  const page = pageInput(input, "payment-applications", scope.bookId);
  return scope.database.transaction(async (client) => {
    const rows = await queryPaymentApplications(client, scope, input, page);
    return toPage(rows, page.limit, "payment-applications", scope.bookId, (item) => ({
      date: item.applicationDate,
      id: item.applicationId
    }));
  });
}

async function getPaymentApplication(scope: Scope, applicationId: string): Promise<PaymentApplicationDetail> {
  assertNonEmpty(applicationId, "applicationId");
  const page = await listPaymentApplications(scope, { applicationId, limit: 1 });
  const application = page.items[0];
  if (application === undefined) {
    throw new ErpFinancialsError("missing_document", `Payment application ${applicationId} does not exist in reporting book ${scope.bookId}`, {
      details: { applicationId, bookId: scope.bookId }
    });
  }
  return application;
}

async function findPaymentApplicationByKey(scope: Scope, request: { readonly sourceId: string; readonly idempotencyKey: string }): Promise<PaymentApplicationCommandReceipt | null> {
  const input = { ...request };
  // Match command identity validation; ordinary search-text length limits must
  // not make a previously accepted native key impossible to retrieve.
  for (const [field,value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) throw new ErpFinancialsError("invalid_input", `${field} must be a nonempty string`);
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    // The existing unique tenant/company/source/key index bounds this lookup.
    // No document list, amount/date matching, or application-history scan.
    const row = (await client.query(`select application.*,
      application.subledger_application_id as application_id,
      application.source_document_id as source_payment_id,
      application.application_date::text as application_date,
      event.payload as command_payload,event.aggregate_type,event.aggregate_id,event.event_type
      from erp_financials.subledger_applications application
      join erp_financials.reporting_book_sources source
        on source.tenant_id=application.tenant_id and source.company_id=application.company_id
        and source.source_id=application.source_id and source.book_id=$3
        and (source.effective_from is null or source.effective_from<=application.application_date)
        and (source.effective_through is null or source.effective_through>=application.application_date)
      left join erp_financials.financial_lifecycle_events event
        on event.tenant_id=application.tenant_id and event.company_id=application.company_id
        and event.source_id=application.source_id and event.event_id=application.applied_event_id
      where application.tenant_id=$1 and application.company_id=$2 and application.source_id=$4
        and application.idempotency_key=$5 and application.currency_code=$6 limit 1`,
    [scope.tenantId,scope.companyId,scope.bookId,input.sourceId,input.idempotencyKey,book.currencyCode])).rows[0];
    if (!row) return null;
    const application = paymentApplicationFromRow(row);
    if (row.aggregate_type !== "subledger_application" || row.aggregate_id !== application.applicationId || row.event_type !== "subledger_application.applied") {
      throw new ErpFinancialsError("invalid_input", "Application command lifecycle evidence is missing or inconsistent");
    }
    const payload = jsonObject(row.command_payload, "application command evidence");
    const hasEvidence = payload.commandVersion !== undefined || payload.commandChecksum !== undefined ||
      payload.expectedSourceVersion !== undefined || payload.expectedTargetVersion !== undefined;
    if (!hasEvidence) return {application,idempotencyKey:input.idempotencyKey,originalExpectedVersions:null};
    const source=payload.expectedSourceVersion,target=payload.expectedTargetVersion;
    if (payload.commandVersion !== 1 || typeof payload.commandChecksum !== "string" || !/^[a-f0-9]{64}$/.test(payload.commandChecksum) ||
      typeof source !== "number" || !Number.isSafeInteger(source) || source < 1 ||
      typeof target !== "number" || !Number.isSafeInteger(target) || target < 1) {
      throw new ErpFinancialsError("invalid_input", "Application command version evidence is invalid or unsupported");
    }
    return {application,idempotencyKey:input.idempotencyKey,originalExpectedVersions:{source,target}};
  });
}

async function queryPaymentApplications(
  client: PostgresQueryClient,
  scope: Scope,
  input: {
    readonly applicationType?: PaymentApplicationListItem["applicationType"];
    readonly status?: PaymentApplicationListItem["status"];
    readonly sourcePaymentId?: string;
    readonly targetDocumentId?: string;
    readonly applicationId?: string;
  },
  page?: ReturnType<typeof pageInput>
): Promise<readonly PaymentApplicationListItem[]> {
  const result = await client.query(
    `select application."subledger_application_id" as "application_id", application."source_id",
  application."application_type", application."status", application."version", application."application_date"::text as "application_date",
  application."source_document_id" as "source_payment_id", application."target_document_id",
  application."applied_amount", application."currency_code", application."applied_event_id", application."ended_event_id",
  application."match_candidate_id", application."match_decision_id", application."match_method", application."match_score",
  application."match_evidence"
from "erp_financials"."subledger_applications" application
join "erp_financials"."subledger_documents" source_document
  on source_document."tenant_id" = application."tenant_id" and source_document."company_id" = application."company_id"
 and source_document."source_id" = application."source_id" and source_document."subledger_document_id" = application."source_document_id"
join "erp_financials"."subledger_documents" target_document
  on target_document."tenant_id" = application."tenant_id" and target_document."company_id" = application."company_id"
 and target_document."source_id" = application."source_id" and target_document."subledger_document_id" = application."target_document_id"
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = application."tenant_id" and source."company_id" = application."company_id"
 and source."book_id" = $3 and source."source_id" = application."source_id"
where application."tenant_id" = $1 and application."company_id" = $2
  and ($4::text is null or application."application_type" = $4)
  and ($5::text is null or application."status" = $5)
  and ($6::text is null or application."source_document_id" = $6)
  and ($7::text is null or application."target_document_id" = $7)
  and ($8::text is null or application."subledger_application_id" = $8)
  and ($9::date is null or (application."application_date", application."subledger_application_id") < ($9::date, $10::text))
order by application."application_date" desc, application."subledger_application_id" desc
limit $11`,
    [scope.tenantId, scope.companyId, scope.bookId, input.applicationType, input.status, input.sourcePaymentId,
      input.targetDocumentId, input.applicationId, page?.date, page?.id, (page?.limit ?? 100) + 1]
  );
  return result.rows.map(paymentApplicationFromRow);
}

const ADJUSTMENT_REGISTER_FILTERS: ReadonlySet<AdjustmentRegisterFilter> = new Set(["all", "credit", "refund", "open"]);
const ADJUSTMENT_REGISTER_SORTS: ReadonlySet<AdjustmentRegisterSort> = new Set([
  "document", "type", "customer", "date", "reason", "appliedTo", "amount", "status"
]);
const ADJUSTMENT_REGISTER_DIRECTIONS: ReadonlySet<AdjustmentRegisterDirection> = new Set(["asc", "desc"]);
const ADJUSTMENT_REGISTER_TRAVERSALS = new Set(["forward", "backward"]);
const ADJUSTMENT_REGISTER_LIFECYCLES: ReadonlySet<AdjustmentRegisterLifecycleStatus> = new Set([
  "open", "partially_applied", "applied", "voided", "replaced"
]);

type AdjustmentRegisterOrdering = {
  readonly expression: string;
  readonly cast: "text" | "date" | "numeric";
  readonly nullable: boolean;
  readonly direction: AdjustmentRegisterDirection;
  readonly nulls: "first" | "last";
};

async function listAdjustmentRegister(
  scope: Scope,
  input: {
    readonly asOfDate: IsoDate;
    readonly filter: AdjustmentRegisterFilter;
    readonly sort: AdjustmentRegisterSort;
    readonly direction: AdjustmentRegisterDirection;
    readonly limit: number;
    readonly boundary?: AdjustmentRegisterBoundary;
  }
): Promise<AdjustmentRegisterProjection> {
  assertDate(input.asOfDate, "asOfDate");
  if (!ADJUSTMENT_REGISTER_FILTERS.has(input.filter)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported adjustment register filter");
  }
  if (!ADJUSTMENT_REGISTER_SORTS.has(input.sort)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported adjustment register sort");
  }
  if (!ADJUSTMENT_REGISTER_DIRECTIONS.has(input.direction)) {
    throw new ErpFinancialsError("invalid_input", "Unsupported adjustment register direction");
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register limit must be an integer between 1 and 200");
  }
  const boundary = adjustmentRegisterBoundary(input.boundary, input.sort, input.direction);
  const quarterStart = adjustmentRegisterQuarterStart(input.asOfDate);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const traversal = boundary?.traversal ?? "forward";
    const ordering = adjustmentRegisterOrdering(input.sort, input.direction, traversal);
    const parameters: unknown[] = [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.filter];
    let boundarySql = "";
    if (boundary !== undefined) {
      parameters.push(boundary.value, boundary.adjustmentId);
      boundarySql = adjustmentRegisterBoundarySql(ordering, boundary.value === null);
    }
    parameters.push(input.limit + 1);
    const pageResult = await client.query(
      `with active_application_labels as (
  select application."source_document_id" as "adjustment_id",
    array_agg(invoice."document_number" order by invoice."document_number" collate "C", invoice."subledger_document_id")
      filter (where invoice."document_number" is not null) as "invoice_numbers",
    string_agg(invoice."document_number", ', ' order by invoice."document_number" collate "C", invoice."subledger_document_id")
      filter (where invoice."document_number" is not null) as "applied_to"
  from "erp_financials"."subledger_applications" application
  join "erp_financials"."reporting_book_sources" application_source
    on application_source."tenant_id" = application."tenant_id" and application_source."company_id" = application."company_id"
   and application_source."book_id" = $3 and application_source."source_id" = application."source_id"
   and (application_source."effective_from" is null or application_source."effective_from" <= application."application_date")
   and (application_source."effective_through" is null or application_source."effective_through" >= application."application_date")
  join "erp_financials"."subledger_documents" invoice
    on invoice."tenant_id" = application."tenant_id" and invoice."company_id" = application."company_id"
   and invoice."source_id" = application."source_id" and invoice."subledger_document_id" = application."target_document_id"
   and invoice."document_type" = 'invoice' and invoice."currency_code" = $4
  join "erp_financials"."reporting_book_sources" invoice_source
    on invoice_source."tenant_id" = invoice."tenant_id" and invoice_source."company_id" = invoice."company_id"
   and invoice_source."book_id" = $3 and invoice_source."source_id" = invoice."source_id"
   and (invoice_source."effective_from" is null or invoice_source."effective_from" <= coalesce(invoice."recognition_date",invoice."document_date"))
   and (invoice_source."effective_through" is null or invoice_source."effective_through" >= coalesce(invoice."recognition_date",invoice."document_date"))
  where application."tenant_id" = $1 and application."company_id" = $2
    and application."application_type" = 'credit_to_invoice' and application."status" = 'applied'
    and application."currency_code" = $4
  group by application."source_document_id"
), adjustment_rows as (
  select document."subledger_document_id" as "adjustment_id", document."source_id", document."transaction_id",
    case when document."document_type" = 'credit_memo' then 'credit' else 'refund' end as "adjustment_type",
    document."party_id", party."display_name" as "party_name", document."document_number", document."document_date",
    document."currency_code", document."original_amount", document."open_amount", document."version",
    transaction."memo" as "reason", void_link."related_transaction_id" as "reversal_transaction_id",
    replacement."subledger_document_id" as "replacement_adjustment_id",
    replaced_original."subledger_document_id" as "replaces_adjustment_id",
    labels."invoice_numbers", labels."applied_to",
    case
      when replacement."subledger_document_id" is not null or document."status" = 'replaced' then 'replaced'
      when void_link."related_transaction_id" is not null or document."status" = 'voided' then 'voided'
      when document."document_type" = 'refund' or document."open_amount" <= 0 then 'applied'
      when document."open_amount" < document."original_amount" then 'partially_applied'
      else 'open'
    end as "lifecycle_status"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id"
  join "erp_financials"."transactions" transaction
    on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
   and transaction."transaction_id" = document."transaction_id"
  left join active_application_labels labels on labels."adjustment_id" = document."subledger_document_id"
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void') limit 1
  ) void_link on true
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replacement_link on true
  left join "erp_financials"."subledger_documents" replacement
    on replacement."tenant_id" = document."tenant_id" and replacement."company_id" = document."company_id"
   and replacement."source_id" = document."source_id" and replacement."transaction_id" = replacement_link."related_transaction_id"
   and replacement."document_type" = document."document_type"
  left join lateral (
    select link."original_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."related_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replaced_link on true
  left join "erp_financials"."subledger_documents" replaced_original
    on replaced_original."tenant_id" = document."tenant_id" and replaced_original."company_id" = document."company_id"
   and replaced_original."source_id" = document."source_id" and replaced_original."transaction_id" = replaced_link."original_transaction_id"
   and replaced_original."document_type" = document."document_type"
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" in ('credit_memo', 'refund') and document."currency_code" = $4
), filtered_rows as (
  select *, case when "lifecycle_status" in ('voided', 'replaced') then 0.0000::numeric else -abs("original_amount") end as "signed_amount",
    -abs("open_amount") as "signed_remaining_amount"
  from adjustment_rows
  where $5::text = 'all' or "adjustment_type" = $5
    or ($5::text = 'open' and "adjustment_type" = 'credit' and "lifecycle_status" in ('open', 'partially_applied'))
)
select adjustment.*, adjustment."document_date"::text as "document_date", (${ordering.expression})::text as "sort_key"
from filtered_rows adjustment
where true
${boundarySql}
order by ${ordering.expression} ${ordering.direction} nulls ${ordering.nulls},
  adjustment."adjustment_id" ${ordering.direction}
limit $${String(parameters.length)}`,
      parameters
    );
    const selectedRows = pageResult.rows.slice(0, input.limit);
    if (traversal === "backward") selectedRows.reverse();
    const items = selectedRows.map((row) => adjustmentRegisterRowFromRow(row, input.sort));
    const totalsResult = await client.query(
      `with adjustment_rows as (
  select case when document."document_type" = 'credit_memo' then 'credit' else 'refund' end as "adjustment_type",
    document."document_date", document."original_amount", document."open_amount",
    case
      when replacement."subledger_document_id" is not null or document."status" = 'replaced' then 'replaced'
      when void_link."related_transaction_id" is not null or document."status" = 'voided' then 'voided'
      when document."document_type" = 'refund' or document."open_amount" <= 0 then 'applied'
      when document."open_amount" < document."original_amount" then 'partially_applied'
      else 'open'
    end as "lifecycle_status"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void') limit 1
  ) void_link on true
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replacement_link on true
  left join "erp_financials"."subledger_documents" replacement
    on replacement."tenant_id" = document."tenant_id" and replacement."company_id" = document."company_id"
   and replacement."source_id" = document."source_id" and replacement."transaction_id" = replacement_link."related_transaction_id"
   and replacement."document_type" = document."document_type"
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" in ('credit_memo', 'refund') and document."currency_code" = $4
)
select count(*)::integer as "unfiltered_count",
  count(*) filter (where $5::text = 'all' or "adjustment_type" = $5
    or ($5::text = 'open' and "adjustment_type" = 'credit' and "lifecycle_status" in ('open', 'partially_applied')))::integer as "filtered_count",
  coalesce(sum(-abs("original_amount")) filter (where "lifecycle_status" not in ('voided', 'replaced')
    and "document_date" between $6::date and $7::date), 0.0000::numeric) as "issued_amount",
  count(*) filter (where "lifecycle_status" not in ('voided', 'replaced')
    and "document_date" between $6::date and $7::date)::integer as "issued_count",
  coalesce(sum(-abs("open_amount")) filter (where "adjustment_type" = 'credit'
    and "lifecycle_status" in ('open', 'partially_applied')), 0.0000::numeric) as "unapplied_amount",
  count(*) filter (where "adjustment_type" = 'credit'
    and "lifecycle_status" in ('open', 'partially_applied'))::integer as "unapplied_count",
  coalesce(sum(case when "lifecycle_status" = 'replaced' then 0.0000::numeric else -abs("original_amount") end)
    filter (where "adjustment_type" = 'refund' and "lifecycle_status" <> 'voided'), 0.0000::numeric) as "refunded_amount",
  count(*) filter (where "adjustment_type" = 'refund' and "lifecycle_status" <> 'voided')::integer as "refunded_count"
from adjustment_rows`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.filter, quarterStart, input.asOfDate]
    );
    const totalsRow = requiredRow(totalsResult.rows[0], "adjustment register totals");
    const hasMore = pageResult.rows.length > input.limit;
    const hasPrevious = items.length > 0 && (traversal === "backward" ? hasMore : boundary !== undefined);
    const hasNext = items.length > 0 && (traversal === "forward" ? hasMore : boundary !== undefined);
    const first = items[0];
    const last = items.at(-1);
    return {
      quarterStart,
      asOfDate: input.asOfDate,
      currencyCode: book.currencyCode,
      items,
      totalCount: integer(totalsRow.filtered_count, "filtered_count"),
      unfilteredCount: integer(totalsRow.unfiltered_count, "unfiltered_count"),
      totals: {
        issuedAmount: decimal(totalsRow.issued_amount, "issued_amount"),
        issuedCount: integer(totalsRow.issued_count, "issued_count"),
        unappliedAmount: decimal(totalsRow.unapplied_amount, "unapplied_amount"),
        unappliedCount: integer(totalsRow.unapplied_count, "unapplied_count"),
        refundedAmount: decimal(totalsRow.refunded_amount, "refunded_amount"),
        refundedCount: integer(totalsRow.refunded_count, "refunded_count")
      },
      hasPrevious,
      hasNext,
      ...(hasPrevious && first !== undefined
        ? { previousBoundary: adjustmentRegisterBoundaryFor(first, input.sort, input.direction, "backward") }
        : {}),
      ...(hasNext && last !== undefined
        ? { nextBoundary: adjustmentRegisterBoundaryFor(last, input.sort, input.direction, "forward") }
        : {})
    };
  });
}

function adjustmentRegisterQuarterStart(asOfDate: IsoDate): IsoDate {
  const year = asOfDate.slice(0, 4);
  const month = Number(asOfDate.slice(5, 7));
  const quarterMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0");
  return `${year}-${quarterMonth}-01`;
}

function adjustmentRegisterBoundary(
  value: AdjustmentRegisterBoundary | undefined,
  sort: AdjustmentRegisterSort,
  direction: AdjustmentRegisterDirection
): AdjustmentRegisterBoundary | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.sort !== sort || value.direction !== direction ||
      !ADJUSTMENT_REGISTER_TRAVERSALS.has(value.traversal) ||
      typeof value.adjustmentId !== "string" || value.adjustmentId.trim().length === 0 ||
      (value.value !== null && typeof value.value !== "string")) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register boundary does not match sort and direction");
  }
  if ((sort === "date" || sort === "amount" || sort === "type" || sort === "status") && value.value === null) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register boundary value is invalid for sort");
  }
  if (sort === "date" && value.value !== null) assertDate(value.value, "boundary.value");
  if (sort === "amount" && !/^-?\d+(?:\.\d+)?$/u.test(value.value ?? "")) {
    throw new ErpFinancialsError("invalid_input", "boundary.value must be a decimal");
  }
  if (sort === "type" && value.value !== "credit" && value.value !== "refund") {
    throw new ErpFinancialsError("invalid_input", "Adjustment register type boundary is invalid");
  }
  if (sort === "status" && !ADJUSTMENT_REGISTER_LIFECYCLES.has(value.value as AdjustmentRegisterLifecycleStatus)) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register status boundary is invalid");
  }
  if ((sort === "document" || sort === "customer" || sort === "reason" || sort === "appliedTo") &&
      value.value !== null && value.value.length === 0) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register boundary text must not be empty");
  }
  return value;
}

function adjustmentRegisterOrdering(
  sort: AdjustmentRegisterSort,
  direction: AdjustmentRegisterDirection,
  traversal: "forward" | "backward"
): AdjustmentRegisterOrdering {
  const definitions: Record<AdjustmentRegisterSort, Omit<AdjustmentRegisterOrdering, "direction" | "nulls">> = {
    document: { expression: 'adjustment."document_number" collate "C"', cast: "text", nullable: true },
    type: { expression: 'adjustment."adjustment_type" collate "C"', cast: "text", nullable: false },
    customer: { expression: 'adjustment."party_name" collate "C"', cast: "text", nullable: true },
    date: { expression: 'adjustment."document_date"', cast: "date", nullable: false },
    reason: { expression: 'adjustment."reason" collate "C"', cast: "text", nullable: true },
    appliedTo: { expression: 'adjustment."applied_to" collate "C"', cast: "text", nullable: true },
    amount: { expression: 'adjustment."signed_amount"', cast: "numeric", nullable: false },
    status: { expression: 'adjustment."lifecycle_status" collate "C"', cast: "text", nullable: false }
  };
  const reversed = traversal === "backward";
  return {
    ...definitions[sort],
    direction: reversed ? (direction === "asc" ? "desc" : "asc") : direction,
    nulls: reversed ? "first" : "last"
  };
}

function adjustmentRegisterBoundarySql(ordering: AdjustmentRegisterOrdering, boundaryIsNull: boolean): string {
  const comparison = ordering.direction === "asc" ? ">" : "<";
  const idComparison = `adjustment."adjustment_id" ${comparison} $7::text`;
  if (boundaryIsNull) {
    return ordering.nulls === "first"
      ? `  and $6::text is null and (${ordering.expression} is not null or (${ordering.expression} is null and ${idComparison}))`
      : `  and $6::text is null and ${ordering.expression} is null and ${idComparison}`;
  }
  const parameter = ordering.cast === "text" ? '($6::text collate "C")' : `$6::${ordering.cast}`;
  const comparisonSql = `${ordering.expression} ${comparison} ${parameter} or (${ordering.expression} = ${parameter} and ${idComparison})`;
  return ordering.nulls === "last"
    ? `  and ((${ordering.expression} is not null and (${comparisonSql})) or ${ordering.expression} is null)`
    : `  and ${ordering.expression} is not null and (${comparisonSql})`;
}

function adjustmentRegisterRowFromRow(
  row: Record<string, unknown>,
  sort: AdjustmentRegisterSort
): AdjustmentRegisterRow {
  const customerName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  const reversalTransactionId = optionalString(row.reversal_transaction_id);
  const replacementAdjustmentId = optionalString(row.replacement_adjustment_id);
  const replacesAdjustmentId = optionalString(row.replaces_adjustment_id);
  const reason = optionalString(row.reason);
  const appliedTo = optionalString(row.applied_to);
  const invoiceNumbers = row.invoice_numbers;
  if (invoiceNumbers !== null && invoiceNumbers !== undefined &&
      (!Array.isArray(invoiceNumbers) || invoiceNumbers.some((value) => typeof value !== "string"))) {
    throw new ErpFinancialsError("invalid_input", "Adjustment register invoice labels are invalid");
  }
  return {
    adjustmentId: string(row.adjustment_id, "adjustment_id"),
    sourceId: string(row.source_id, "source_id"),
    transactionId: string(row.transaction_id, "transaction_id"),
    adjustmentType: string(row.adjustment_type, "adjustment_type") as AdjustmentType,
    customerId: string(row.party_id, "party_id"),
    ...(customerName === undefined ? {} : { customerName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    adjustmentDate: date(row.document_date, "document_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    amount: decimal(row.signed_amount, "signed_amount"),
    remainingAmount: decimal(row.signed_remaining_amount, "signed_remaining_amount"),
    status: string(row.lifecycle_status, "lifecycle_status") as AdjustmentRegisterLifecycleStatus,
    version: integer(row.version, "version"),
    ...(reversalTransactionId === undefined ? {} : { reversalTransactionId }),
    ...(replacementAdjustmentId === undefined ? {} : { replacementAdjustmentId }),
    ...(replacesAdjustmentId === undefined ? {} : { replacesAdjustmentId }),
    reason: reason ?? null,
    appliedInvoiceDocumentNumbers: (invoiceNumbers ?? []) as string[],
    appliedTo: appliedTo ?? null,
    sortValue: adjustmentRegisterSortValue(row, sort)
  };
}

function adjustmentRegisterSortValue(row: Record<string, unknown>, sort: AdjustmentRegisterSort): string | null {
  if (row.sort_key === null || row.sort_key === undefined) return null;
  if (sort === "date") return date(row.sort_key, "sort_key");
  if (sort === "amount") return decimal(row.sort_key, "sort_key");
  return string(row.sort_key, "sort_key");
}

function adjustmentRegisterBoundaryFor(
  item: AdjustmentRegisterRow,
  sort: AdjustmentRegisterSort,
  direction: AdjustmentRegisterDirection,
  traversal: "forward" | "backward"
): AdjustmentRegisterBoundary {
  return { sort, direction, traversal, value: item.sortValue, adjustmentId: item.adjustmentId };
}

async function listAdjustments(
  scope: Scope,
  input: PageRequest & {
    readonly adjustmentType?: AdjustmentType;
    readonly status?: AdjustmentStatus;
    readonly adjustmentId?: string;
  }
): Promise<Page<AdjustmentListItem>> {
  const page = pageInput(input, "adjustments", scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with adjustment_rows as (
  select document."subledger_document_id" as "adjustment_id", document."source_id", document."transaction_id",
    case when document."document_type" = 'credit_memo' then 'credit' else 'refund' end as "adjustment_type",
    document."party_id", party."display_name" as "party_name", document."document_number", document."document_date",
    document."currency_code", document."original_amount", document."open_amount", document."version",
    void_link."related_transaction_id" as "reversal_transaction_id",
    replacement."subledger_document_id" as "replacement_adjustment_id",
    replaced_original."subledger_document_id" as "replaces_adjustment_id",
    case when replacement."subledger_document_id" is not null then 'replaced' else document."status" end as "status"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id"
   and party."party_id" = document."party_id"
  left join lateral (
    select link."related_transaction_id"
    from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void')
    limit 1
  ) void_link on true
  left join lateral (
    select link."related_transaction_id"
    from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement'
    limit 1
  ) replacement_link on true
  left join "erp_financials"."subledger_documents" replacement
    on replacement."tenant_id" = document."tenant_id" and replacement."company_id" = document."company_id"
   and replacement."source_id" = document."source_id"
   and replacement."transaction_id" = replacement_link."related_transaction_id"
   and replacement."document_type" = document."document_type"
  left join lateral (
    select link."original_transaction_id"
    from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."related_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement'
    limit 1
  ) replaced_link on true
  left join "erp_financials"."subledger_documents" replaced_original
    on replaced_original."tenant_id" = document."tenant_id" and replaced_original."company_id" = document."company_id"
   and replaced_original."source_id" = document."source_id"
   and replaced_original."transaction_id" = replaced_link."original_transaction_id"
   and replaced_original."document_type" = document."document_type"
  where document."tenant_id" = $1 and document."company_id" = $2
    and document."document_type" in ('credit_memo', 'refund') and document."currency_code" = $4
    and ($9::text is null or document."subledger_document_id" = $9)
)
select *, "document_date"::text as "document_date" from adjustment_rows
where ($5::text is null or "adjustment_type" = $5)
  and ($6::text is null or "status" = $6)
  and ($7::date is null or ("document_date", "adjustment_id") < ($7::date, $8::text))
order by adjustment_rows."document_date" desc, "adjustment_id" desc
limit $10`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        book.currencyCode,
        input.adjustmentType,
        input.status,
        page.date,
        page.id,
        input.adjustmentId,
        page.limit + 1
      ]
    );
    return toPage(result.rows.map(adjustmentFromRow), page.limit, "adjustments", scope.bookId, (item) => ({
      date: item.adjustmentDate,
      id: item.adjustmentId
    }));
  });
}

async function getAdjustment(scope: Scope, adjustmentId: string): Promise<AdjustmentDetail> {
  assertNonEmpty(adjustmentId, "adjustmentId");
  const page = await listAdjustments(scope, { adjustmentId, limit: 1 });
  const adjustment = page.items[0];
  if (adjustment === undefined) {
    throw new ErpFinancialsError(
      "missing_document",
      `Adjustment ${adjustmentId} does not exist in reporting book ${scope.bookId}`,
      { details: { adjustmentId, bookId: scope.bookId } }
    );
  }
  return scope.database.transaction(async (client) => {
    const header = await client.query(
      `select transaction."memo", document."metadata", lifecycle."event_id" as "lifecycle_event_id",
  lifecycle."actor_ref", lifecycle."approver_ref", lifecycle."request_id", lifecycle."reason_code"
from "erp_financials"."transactions" transaction
join "erp_financials"."subledger_documents" document
  on document."tenant_id" = transaction."tenant_id" and document."source_id" = transaction."source_id"
 and document."transaction_id" = transaction."transaction_id"
join "erp_financials"."financial_lifecycle_events" lifecycle
  on lifecycle."tenant_id" = document."tenant_id" and lifecycle."company_id" = document."company_id"
 and lifecycle."source_id" = document."source_id" and lifecycle."event_id" = document."lifecycle_event_id"
where transaction."tenant_id" = $1 and transaction."source_id" = $2 and transaction."transaction_id" = $3`,
      [scope.tenantId, adjustment.sourceId, adjustment.transactionId]
    );
    const lines = await client.query(
      `select "subledger_document_line_id" as "line_id", *, "service_period_start"::text as "service_period_start", "service_period_end"::text as "service_period_end"
from "erp_financials"."subledger_document_lines"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "subledger_document_id" = $4
order by "line_number"`,
      [scope.tenantId, scope.companyId, adjustment.sourceId, adjustment.adjustmentId]
    );
    const postings = await client.query(
      `select posting."posting_id", posting."account_id", posting."item_id", line."description",
  posting."debit_amount", posting."credit_amount", posting."currency_code", posting."dimension_refs",
  coalesce(mapping."book_account_key", posting."source_id" || ':' || posting."account_id") as "book_account_key",
  coalesce(book_account."name", account."name") as "account_name"
from "erp_financials"."ledger_postings" posting
join "erp_financials"."accounts" account
  on account."tenant_id" = posting."tenant_id" and account."source_id" = posting."source_id"
 and account."account_id" = posting."account_id"
left join "erp_financials"."transaction_lines" line
  on line."tenant_id" = posting."tenant_id" and line."source_id" = posting."source_id"
 and line."transaction_line_id" = posting."transaction_line_id"
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = posting."source_id" and mapping."account_id" = posting."account_id"
left join "erp_financials"."reporting_book_accounts" book_account
  on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
 and book_account."book_account_key" = mapping."book_account_key"
where posting."tenant_id" = $1 and posting."source_id" = $4 and posting."transaction_id" = $5
order by posting."posting_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, adjustment.sourceId, adjustment.transactionId]
    );
    const applications = await client.query(
      `select application."subledger_application_id" as "application_id",
  application."target_document_id" as "invoice_id", application."application_date"::text as "application_date",
  application."applied_amount", application."status", application."version"
from "erp_financials"."subledger_applications" application
where application."tenant_id" = $1 and application."company_id" = $2 and application."source_id" = $3
  and application."source_document_id" = $4 and application."application_type" = 'credit_to_invoice'
order by application."application_date", application."subledger_application_id"`,
      [scope.tenantId, scope.companyId, adjustment.sourceId, adjustment.adjustmentId]
    );
    const headerRow = header.rows[0];
    const memo = optionalString(headerRow?.memo);
    const lifecycle = headerRow?.lifecycle_event_id === undefined ? undefined : lifecycleFromRow(headerRow);
    const refundProvenance = adjustment.adjustmentType === "refund"
      ? refundProvenanceFromMetadata(headerRow?.metadata)
      : undefined;
    return {
      ...adjustment,
      ...(memo === undefined ? {} : { memo }),
      lines: lines.rows.map(commercialLineFromRow),
      postings: postings.rows.map(adjustmentPostingFromRow),
      applications: applications.rows.map(adjustmentApplicationFromRow),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(refundProvenance === undefined ? {} : { refundProvenance })
    };
  });
}

async function listWriteOffs(
  scope: Scope,
  input: PageRequest & { readonly customerId?: string; readonly status?: WriteOffListItem["status"]; readonly writeOffId?: string }
): Promise<Page<WriteOffListItem>> {
  const page = pageInput(input, "write-offs", scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with write_off_rows as (
  select document."subledger_document_id" as "write_off_id", document."source_id", document."transaction_id",
    document."party_id", party."display_name" as "party_name", document."document_number", document."document_date",
    document."currency_code", document."original_amount", document."version", document."metadata",
    void_link."related_transaction_id" as "reversal_transaction_id",
    replacement."subledger_document_id" as "replacement_write_off_id",
    replaced_original."subledger_document_id" as "replaces_write_off_id",
    case when replacement."subledger_document_id" is not null then 'replaced' else document."status" end as "status"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
  left join "erp_financials"."parties" party
    on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id" and party."party_id" = document."party_id"
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" in ('reversal', 'void') limit 1
  ) void_link on true
  left join lateral (
    select link."related_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."original_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replacement_link on true
  left join "erp_financials"."subledger_documents" replacement
    on replacement."tenant_id" = document."tenant_id" and replacement."company_id" = document."company_id"
   and replacement."source_id" = document."source_id" and replacement."transaction_id" = replacement_link."related_transaction_id"
   and replacement."document_type" = 'write_off'
  left join lateral (
    select link."original_transaction_id" from "erp_financials"."journal_entry_links" link
    where link."tenant_id" = document."tenant_id" and link."company_id" = document."company_id"
      and link."source_id" = document."source_id" and link."related_transaction_id" = document."transaction_id"
      and link."link_type" = 'replacement' limit 1
  ) replaced_link on true
  left join "erp_financials"."subledger_documents" replaced_original
    on replaced_original."tenant_id" = document."tenant_id" and replaced_original."company_id" = document."company_id"
   and replaced_original."source_id" = document."source_id" and replaced_original."transaction_id" = replaced_link."original_transaction_id"
   and replaced_original."document_type" = 'write_off'
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'write_off'
    and document."currency_code" = $4 and ($9::text is null or document."subledger_document_id" = $9)
)
select *, "document_date"::text as "document_date" from write_off_rows
where ($5::text is null or "party_id" = $5) and ($6::text is null or "status" = $6)
  and ($7::date is null or ("document_date", "write_off_id") < ($7::date, $8::text))
order by write_off_rows."document_date" desc, "write_off_id" desc
limit $10`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.customerId, input.status,
        page.date, page.id, input.writeOffId, page.limit + 1]
    );
    return toPage(result.rows.map(writeOffFromRow), page.limit, "write-offs", scope.bookId, (item) => ({
      date: item.writeOffDate,
      id: item.writeOffId
    }));
  });
}

async function getWriteOff(scope: Scope, writeOffId: string): Promise<WriteOffDetail> {
  assertNonEmpty(writeOffId, "writeOffId");
  const page = await listWriteOffs(scope, { writeOffId, limit: 1 });
  const writeOff = page.items[0];
  if (writeOff === undefined) {
    throw new ErpFinancialsError("missing_document", `Write-off ${writeOffId} does not exist in reporting book ${scope.bookId}`, {
      details: { bookId: scope.bookId, writeOffId }
    });
  }
  return scope.database.transaction(async (client) => {
    const result = await client.query(
      `select transaction."memo", document."metadata", lifecycle."event_id" as "lifecycle_event_id",
  lifecycle."actor_ref", lifecycle."approver_ref", lifecycle."request_id", lifecycle."reason_code"
from "erp_financials"."subledger_documents" document
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = document."tenant_id" and transaction."source_id" = document."source_id"
 and transaction."transaction_id" = document."transaction_id"
join "erp_financials"."financial_lifecycle_events" lifecycle
  on lifecycle."tenant_id" = document."tenant_id" and lifecycle."company_id" = document."company_id"
 and lifecycle."source_id" = document."source_id" and lifecycle."event_id" = document."lifecycle_event_id"
where document."tenant_id" = $1 and document."company_id" = $2 and document."source_id" = $3
  and document."subledger_document_id" = $4 and document."document_type" = 'write_off'`,
      [scope.tenantId, scope.companyId, writeOff.sourceId, writeOffId]
    );
    const row = requiredRow(result.rows[0], "write-off detail");
    const provenance = requiredObjectProperty(row.metadata, "writeOffProvenance");
    const memo = optionalString(row.memo);
    return {
      ...writeOff,
      ...(memo === undefined ? {} : { memo }),
      balanceType: string(provenance.balanceType, "writeOffProvenance.balanceType") as WriteOffDetail["balanceType"],
      balanceAccountId: string(provenance.balanceAccountId, "writeOffProvenance.balanceAccountId"),
      writeOffAccountId: string(provenance.writeOffAccountId, "writeOffProvenance.writeOffAccountId"),
      lifecycle: lifecycleFromRow(row)
    };
  });
}

async function getPaymentSummary(
  scope: Scope,
  input: { readonly periodStart: IsoDate; readonly periodEnd: IsoDate }
): Promise<PaymentSummary> {
  assertWindow(input.periodStart, input.periodEnd);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `with payments as (
  select document."subledger_document_id", document."original_amount", document."open_amount", document."status",
    coalesce(returned."amount", 0) as "returned_amount"
  from "erp_financials"."subledger_documents" document
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
   and source."book_id" = $3 and source."source_id" = document."source_id"
   and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
   and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
  left join lateral (
    select sum(application."applied_amount") as "amount"
    from "erp_financials"."subledger_applications" application
    where application."tenant_id" = document."tenant_id" and application."company_id" = document."company_id"
      and application."source_id" = document."source_id" and application."source_document_id" = document."subledger_document_id"
      and application."application_type" = 'customer_payment_to_refund' and application."status" = 'applied'
  ) returned on true
  where document."tenant_id" = $1 and document."company_id" = $2 and document."document_type" = 'customer_payment'
    and document."currency_code" = $4 and document."document_date" between $5::date and $6::date
), matched as (
  select payment."subledger_document_id",
    bool_or(application."match_method" = 'automatic') as "automatic"
  from payments payment
  join "erp_financials"."subledger_applications" application
    on application."tenant_id" = $1 and application."company_id" = $2
   and application."source_document_id" = payment."subledger_document_id" and application."status" = 'applied'
   and application."application_type" = 'customer_payment_to_invoice'
  group by payment."subledger_document_id"
)
select coalesce(sum("original_amount"), 0) as "received_amount", count(*)::integer as "received_count",
  coalesce(sum("returned_amount"), 0) as "returned_amount",
  coalesce(sum(case when "status" = 'voided' then 0 else "original_amount" - "returned_amount" end), 0) as "retained_amount",
  coalesce(sum("open_amount") filter (where "open_amount" > 0), 0) as "unapplied_amount",
  count(*) filter (where "open_amount" > 0)::integer as "unapplied_count",
  (select count(*)::integer from matched) as "matched_count",
  (select count(*) filter (where "automatic")::integer from matched) as "automatic_count",
  (select count(*)::integer from "erp_financials"."bank_statement_lines" bank
    where bank."tenant_id" = $1 and bank."company_id" = $2 and bank."book_id" = $3
      and bank."currency_code" = $4 and bank."status" = 'unmatched' and bank."posted_date" <= $6::date) as "awaiting_count"
from payments`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.periodStart, input.periodEnd]
    );
    const row = requiredRow(result.rows[0], "payment summary");
    const matchedPaymentCount = integer(row.matched_count, "matched_count");
    const automaticallyMatchedPaymentCount = integer(row.automatic_count, "automatic_count");
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currencyCode: book.currencyCode,
      receivedAmount: money(row.received_amount, "received_amount"),
      returnedAmount: money(row.returned_amount, "returned_amount"),
      retainedAmount: money(row.retained_amount, "retained_amount"),
      receivedPaymentCount: integer(row.received_count, "received_count"),
      automaticallyMatchedPaymentCount,
      matchedPaymentCount,
      automaticMatchRatePercent: percentage(automaticallyMatchedPaymentCount, matchedPaymentCount),
      unappliedAmount: money(row.unapplied_amount, "unapplied_amount"),
      unappliedPaymentCount: integer(row.unapplied_count, "unapplied_count"),
      awaitingBankReviewCount: integer(row.awaiting_count, "awaiting_count")
    };
  });
}

async function listGeneralLedger(
  scope: Scope,
  input: PageRequest & GeneralLedgerFilters
): Promise<Page<GeneralLedgerLine>> {
  const filters = generalLedgerFilters(input);
  const pageKind = `general-ledger:${generalLedgerFilterFingerprint(filters)}`;
  const page = pageInput(input, pageKind, scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const accountingBasis = filters.accountingMethod ?? book.accountingBasis;
    const result = await client.query(
      `with recursive effective_accounts as (
  select account."tenant_id", account."source_id", account."account_id",
    coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id") as "book_account_key",
    case when mapping."book_account_key" is not null then book_account."parent_book_account_key"
      else coalesce(parent_mapping."book_account_key",
        case when parent_account."account_id" is null then null
          else parent_account."source_id" || ':' || parent_account."account_id" end)
    end as "parent_book_account_key"
  from "erp_financials"."accounts" account
  join "erp_financials"."reporting_book_sources" hierarchy_source
    on hierarchy_source."tenant_id" = $1 and hierarchy_source."company_id" = $2
   and hierarchy_source."book_id" = $3 and hierarchy_source."source_id" = account."source_id"
  left join "erp_financials"."reporting_book_account_mappings" mapping
    on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
   and mapping."source_id" = account."source_id" and mapping."account_id" = account."account_id"
  left join "erp_financials"."reporting_book_accounts" book_account
    on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
   and book_account."book_account_key" = mapping."book_account_key"
  left join "erp_financials"."accounts" parent_account
    on parent_account."tenant_id" = account."tenant_id" and parent_account."source_id" = account."source_id"
   and parent_account."account_id" = account."parent_account_id"
  left join "erp_financials"."reporting_book_account_mappings" parent_mapping
    on parent_mapping."tenant_id" = $1 and parent_mapping."company_id" = $2 and parent_mapping."book_id" = $3
   and parent_mapping."source_id" = parent_account."source_id" and parent_mapping."account_id" = parent_account."account_id"
  where account."tenant_id" = $1
), selected_account_keys("book_account_key") as (
  select $8::text where $8::text is not null
  union
  select account."book_account_key"
  from effective_accounts account
  join selected_account_keys selected
    on account."parent_book_account_key" = selected."book_account_key"
)
select posting."posting_id", posting."source_id", posting."source_posting_id", posting."transaction_id",
  transaction."source_transaction_id", transaction."source_transaction_type", transaction."transaction_number",
  transaction."transaction_date"::text as "transaction_date", posting."posting_date"::text as "posting_date", posting."accounting_basis", posting."account_id",
  coalesce(mapping."book_account_key", posting."source_id" || ':' || posting."account_id") as "book_account_key",
  account."account_number", account."name" as "account_name", posting."party_id", posting."item_id",
  line."description", posting."debit_amount", posting."credit_amount", posting."net_amount", posting."currency_code",
  posting."dimension_refs", source."source_role", accounting_source."source_system",
  accounting_source."provider_environment",
  coalesce(posting."source_payload_ref", transaction."source_payload_ref") as "source_payload_ref"
from "erp_financials"."ledger_postings" posting
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = posting."tenant_id" and transaction."source_id" = posting."source_id" and transaction."transaction_id" = posting."transaction_id"
join "erp_financials"."accounts" account
  on account."tenant_id" = posting."tenant_id" and account."source_id" = posting."source_id" and account."account_id" = posting."account_id"
join "erp_financials"."accounting_sources" accounting_source
  on accounting_source."tenant_id" = posting."tenant_id" and accounting_source."source_id" = posting."source_id"
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = posting."source_id"
 and (source."effective_from" is null or source."effective_from" <= posting."posting_date")
 and (source."effective_through" is null or source."effective_through" >= posting."posting_date")
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = posting."source_id" and mapping."account_id" = posting."account_id"
left join "erp_financials"."transaction_lines" line
  on line."tenant_id" = posting."tenant_id" and line."source_id" = posting."source_id" and line."transaction_line_id" = posting."transaction_line_id"
left join "erp_financials"."parties" party
  on party."tenant_id" = posting."tenant_id" and party."source_id" = posting."source_id" and party."party_id" = posting."party_id"
where posting."tenant_id" = $1 and posting."accounting_basis" = $4 and posting."currency_code" = $5
  and posting."posting_date" between $6::date and $7::date
  and ($8::text is null or coalesce(mapping."book_account_key", posting."source_id" || ':' || posting."account_id") in (
    select "book_account_key" from selected_account_keys
  ))
  and ($9::text is null or posting."source_id" = $9)
  and ($10::text is null or transaction."source_transaction_type" = $10)
  and ($11::text is null or exists (
    select 1 from jsonb_array_elements(coalesce(posting."dimension_refs", '[]'::jsonb)) class_ref
    where lower(class_ref ->> 'dimensionKind') = 'class'
      and (class_ref ->> 'dimensionId' = $11 or class_ref ->> 'sourceDimensionId' = $11)
  ))
  and ($12::text is null or exists (
    select 1 from jsonb_array_elements(coalesce(posting."dimension_refs", '[]'::jsonb)) dimension_ref
    where dimension_ref ->> 'dimensionKind' = $12
      and (dimension_ref ->> 'dimensionId' = $13 or dimension_ref ->> 'sourceDimensionId' = $13)
  ))
  and ($14::text is null or ($14 = 'debit' and posting."debit_amount" > 0) or ($14 = 'credit' and posting."credit_amount" > 0))
  and ($15::text is null or strpos(lower(concat_ws(' ', transaction."transaction_number", transaction."memo",
    line."description", account."account_number", account."name", party."display_name", posting."posting_id",
    transaction."transaction_id")), lower($15)) > 0)
  and ($16::date is null or (posting."posting_date", posting."posting_id") < ($16::date, $17::text))
order by posting."posting_date" desc, posting."posting_id" desc
limit $18`,
      [scope.tenantId, scope.companyId, scope.bookId, accountingBasis, book.currencyCode,
        filters.periodStart, filters.periodEnd, filters.accountKey, filters.sourceId, filters.transactionType,
        filters.classId, filters.dimensionKind, filters.dimensionId, filters.polarity, filters.search,
        page.date, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(ledgerLineFromRow), page.limit, pageKind, scope.bookId, (item) => ({
      date: item.postingDate,
      id: item.postingId
    }));
  });
}

// Parameters 1..7: tenant, company, book, basis, currency, start, end.
const ACCOUNT_REPORT_REVISION_SQL = `  select encode(sha256(convert_to(jsonb_build_array($4::text,$5::text,
    (select to_jsonb(book) from erp_financials.reporting_books book where tenant_id=$1 and company_id=$2 and book_id=$3),
    (select jsonb_agg(to_jsonb(source) order by source.source_id) from erp_financials.reporting_book_sources source where tenant_id=$1 and company_id=$2 and book_id=$3),
    (select jsonb_agg(to_jsonb(account) order by account.source_id,account.account_id) from erp_financials.accounts account join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=account.source_id where account.tenant_id=$1),
    (select jsonb_agg(to_jsonb(account) order by book_account_key) from erp_financials.reporting_book_accounts account where tenant_id=$1 and company_id=$2 and book_id=$3),
    (select jsonb_agg(to_jsonb(mapping) order by source_id,account_id) from erp_financials.reporting_book_account_mappings mapping where tenant_id=$1 and company_id=$2 and book_id=$3),
    (select coalesce(sum(counter.revision),0)::text from erp_financials.accounting_source_revisions counter join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=counter.source_id where counter.tenant_id=$1 and counter.effective_date<=$7::date)
  )::text,'UTF8')),'hex') revision`;

const ACCOUNT_CHART_CLASSES: readonly AccountClassification[] = ["asset", "liability", "equity", "income", "cost_of_goods_sold", "expense", "other_income", "other_expense"];

/** Internal column names only; caller data never enters SQL text. */
function incomeAttributionTotalsSql(aggregate: boolean): string {
  const value = (column: string): string => aggregate ? `coalesce(sum(${column}),0)` : column;
  const income = value("income"), cost = value("cost"), expense = value("expense");
  return `${value("posting_count")}::text as "postingCount",${income}::text income,
    ${cost}::text as "costOfGoodsSold",${expense}::text expenses,
    (${income}-${cost})::text as "grossProfit",(${income}-${cost}-${expense})::text as "netIncome"`;
}

async function getIncomeAttribution(scope: Scope, raw: IncomeAttributionRequest): Promise<IncomeAttributionPage> {
  assertWindow(raw.periodStart, raw.periodEnd);
  assertReportAccountingMethod(raw.accountingMethod);
  const dimensionKind = readFilterText(raw.dimensionKind, "dimensionKind", 100);
  if (!dimensionKind) throw new ErpFinancialsError("invalid_input", "dimensionKind is required");
  const attributionStatus = raw.attributionStatus, sort = raw.sort;
  if (attributionStatus !== undefined && !["assigned", "unassigned", "ambiguous"].includes(attributionStatus)) throw new ErpFinancialsError("invalid_input", "Invalid attribution status");
  if (sort !== undefined && !["identity", "cost_desc", "income_desc"].includes(sort)) throw new ErpFinancialsError("invalid_input", "Invalid attribution sort");
  let reference: IncomeAttributionRequest["reference"];
  if (raw.reference !== undefined) {
    if (!isRecord(raw.reference) || !["dimension", "source_dimension"].includes(raw.reference.kind) ||
      typeof raw.reference.id !== "string" || !raw.reference.id.trim() || Array.from(raw.reference.id).length > 500) throw new ErpFinancialsError("invalid_input", "Invalid attribution reference");
    reference = { kind: raw.reference.kind, id: raw.reference.id };
  }
  const filters = { periodStart: raw.periodStart, periodEnd: raw.periodEnd, dimensionKind,
    accountingMethod: raw.accountingMethod, sourceId: readFilterText(raw.sourceId, "sourceId", 500), attributionStatus, reference, sort };
  // Only fixed internal columns are interpolated. Keys break all monetary ties.
  const amountColumn = sort === "cost_desc" ? "cost" : sort === "income_desc" ? "income" : undefined;
  // Qualify the input numeric: `income` is also an output text alias. Sorting
  // that alias before LIMIT would discard the true highest monetary groups.
  const orderSql = amountColumn ? `matched_groups.${amountColumn} desc,group_key collate "C"` : 'group_key collate "C"';
  const kind = "income-attribution";
  const { limit } = pageInput({ ...(raw.limit === undefined ? {} : { limit: raw.limit }) }, kind, scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, filters])).digest("hex");
  let boundary: string | undefined, expectedRevision: string | undefined, boundaryAmount: string | undefined;
  if (raw.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (typeof raw.cursor !== "string" || raw.cursor.length > 65536) throw new Error();
      cursor = JSON.parse(Buffer.from(raw.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Income attribution cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== kind || cursor.scope !== fingerprint ||
      typeof cursor.key !== "string" || !cursor.key || cursor.key.length > 16384 ||
      typeof cursor.revision !== "string" || !/^[0-9a-f]{64}$/u.test(cursor.revision)) {
      throw new ErpFinancialsError("invalid_input", "Income attribution cursor does not belong to this scope and filters");
    }
    boundary = cursor.key; expectedRevision = cursor.revision;
    if (amountColumn) {
      if (typeof cursor.amount !== "string" || cursor.amount.length > 1000 || !/^-?(0|[1-9]\d*)\.\d{2}$/u.test(cursor.amount)) throw new ErpFinancialsError("invalid_input", "Income attribution cursor amount is invalid");
      boundaryAmount = cursor.amount;
    }
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope), basis = filters.accountingMethod ?? book.accountingBasis;
    // Classification, dimensions, page rows, controls and revision share one SQL
    // snapshot. Combine identical stored reference sets before interpreting
    // them, preserving original posting counts and per-posting precision checks.
    // This avoids repeating JSON attribution work for every historical entry.
    const result = await client.query(`with classified as materialized (
  select posting.source_id,sum(posting.net_amount) net_amount,count(*) posting_count,coalesce(posting.dimension_refs,'[]'::jsonb) refs,
    coalesce(book_account.classification,account.classification) classification,
    bool_or(posting.debit_amount<>trunc(posting.debit_amount,2) or posting.credit_amount<>trunc(posting.credit_amount,2)
      or posting.net_amount<>trunc(posting.net_amount,2)) invalid_precision
  from erp_financials.ledger_postings posting
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date) and (source.effective_through is null or source.effective_through>=posting.posting_date)
  left join erp_financials.accounts account on account.tenant_id=$1 and account.source_id=posting.source_id and account.account_id=posting.account_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  left join erp_financials.reporting_book_accounts book_account on book_account.tenant_id=$1 and book_account.company_id=$2 and book_account.book_id=$3 and book_account.book_account_key=mapping.book_account_key
  where posting.tenant_id=$1 and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date between $6::date and $7::date
    and ($8::text is null or posting.source_id=$8)
  group by posting.source_id,coalesce(posting.dimension_refs,'[]'::jsonb),coalesce(book_account.classification,account.classification)
), attributed as (
  select classified.source_id,classified.net_amount,classified.posting_count,classified.classification,
    case when jsonb_typeof(refs)<>'array' or dims.invalid or dims.identities>1 then 'ambiguous'
      when dims.identities=1 then 'assigned' else 'unassigned' end status,
    case when jsonb_typeof(refs)='array' and not dims.invalid and dims.identities=1 then dims.identity::jsonb->>0 end dimension_id,
    case when jsonb_typeof(refs)='array' and not dims.invalid and dims.identities=1 then dims.identity::jsonb->>1 end source_dimension_id
  from classified
  cross join lateral (
    select count(distinct identity) filter(where valid) identities,min(identity::text) filter(where valid) identity,
      coalesce(bool_or(not valid),false) invalid
    from (
      select jsonb_build_array(ref->>'dimensionId',ref->>'sourceDimensionId') identity,
        coalesce(jsonb_typeof(ref)='object' and jsonb_typeof(ref->'dimensionKind')='string'
        and (ref ? 'dimensionId' or ref ? 'sourceDimensionId')
        and (not ref ? 'dimensionId' or (jsonb_typeof(ref->'dimensionId')='string' and length(btrim(ref->>'dimensionId')) between 1 and 500))
        and (not ref ? 'sourceDimensionId' or (jsonb_typeof(ref->'sourceDimensionId')='string' and length(btrim(ref->>'sourceDimensionId')) between 1 and 500)),false) valid
      from jsonb_array_elements(case when jsonb_typeof(refs)='array' then refs else '[]'::jsonb end) ref
      where ref->>'dimensionKind'=$9 or jsonb_typeof(ref)<>'object' or coalesce(jsonb_typeof(ref->'dimensionKind'),'null')<>'string'
    ) candidates
  ) dims
  where classification in ('income','other_income','cost_of_goods_sold','expense','other_expense')
), grouped as materialized (
  select source_id,status,dimension_id,source_dimension_id,
    jsonb_build_array(source_id,status,dimension_id,source_dimension_id)::text group_key,
    sum(posting_count) posting_count,
    coalesce(sum(-net_amount) filter(where classification in ('income','other_income')),0) income,
    coalesce(sum(net_amount) filter(where classification='cost_of_goods_sold'),0) cost,
    coalesce(sum(net_amount) filter(where classification in ('expense','other_expense')),0) expense
  from attributed group by source_id,status,dimension_id,source_dimension_id
), matched_groups as materialized (
  select * from grouped where ($12::text is null or status=$12)
    and ($13::text is null or ($13='dimension' and dimension_id=$14) or ($13='source_dimension' and source_dimension_id=$14))
), selected as (
  select group_key,source_id,status,dimension_id,source_dimension_id,${incomeAttributionTotalsSql(false)},
    ${amountColumn ?? 'null::numeric'} sort_amount
  from matched_groups where ($10::text is null or ${amountColumn ? `(${amountColumn}<$15::numeric or (${amountColumn}=$15::numeric and group_key collate "C">$10::text collate "C"))` : 'group_key collate "C">$10::text collate "C" and $15::numeric is null'})
  order by ${orderSql} limit $11
), matched as (
  select count(*)::text group_count,${incomeAttributionTotalsSql(true)} from matched_groups
), summary as (
  select count(*)::text group_count,${incomeAttributionTotalsSql(true)} from grouped
), coverage as (
  select statuses.status,${incomeAttributionTotalsSql(true)}
  from (values ('assigned'),('unassigned'),('ambiguous')) statuses(status)
  left join grouped on grouped.status=statuses.status group by statuses.status
), revision as (
${ACCOUNT_REPORT_REVISION_SQL}
)
select (select to_jsonb(summary) from summary) summary,
  (select to_jsonb(matched) from matched) matched,
  (select jsonb_object_agg(status,to_jsonb(coverage)-'status') from coverage) coverage,
  coalesce((select jsonb_agg(to_jsonb(selected) order by ${amountColumn ? 'sort_amount desc,' : ''}group_key collate "C") from selected),'[]'::jsonb) items,
  exists(select 1 from classified where invalid_precision) invalid_precision,
  exists(select 1 from classified where classification is null or classification not in ('asset','liability','equity','income','other_income','cost_of_goods_sold','expense','other_expense')) invalid_classification,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status) from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book,
  revision.revision from revision`,
      [scope.tenantId, scope.companyId, scope.bookId, basis, book.currencyCode, filters.periodStart, filters.periodEnd, filters.sourceId, dimensionKind, boundary, limit + 1, attributionStatus, reference?.kind, reference?.id, boundaryAmount]);
    const row = requiredRow(result.rows[0], "income attribution");
    if (!isRecord(row.current_book) || row.current_book.status !== "active" || row.current_book.currency !== book.currencyCode ||
      (filters.accountingMethod === undefined && row.current_book.basis !== book.accountingBasis)) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during income attribution read; reload");
    if (row.invalid_precision === true || row.invalid_classification === true) throw new ErpFinancialsError("invalid_input", "Income attribution requires classified accounts and exact cent postings");
    const revision = string(row.revision, "revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Accounting changed during pagination; reload income attribution from its first page");
    const totals = (value: unknown): IncomeAttributionTotals => {
      if (!isRecord(value)) throw new Error("Invalid income attribution controls");
      return { postingCount: string(value.postingCount, "postingCount"), income: registerMoney(value.income, "income"),
        costOfGoodsSold: registerMoney(value.costOfGoodsSold, "costOfGoodsSold"), expenses: registerMoney(value.expenses, "expenses"),
        grossProfit: registerMoney(value.grossProfit, "grossProfit"), netIncome: registerMoney(value.netIncome, "netIncome") };
    };
    if (!Array.isArray(row.items) || !isRecord(row.coverage) || !isRecord(row.summary) || !isRecord(row.matched)) throw new Error("Invalid income attribution rows");
    const items = row.items.slice(0, limit).map((value: unknown): IncomeAttributionItem => {
      if (!isRecord(value) || !["assigned", "unassigned", "ambiguous"].includes(String(value.status))) throw new Error("Invalid income attribution group");
      const dimensionId = optionalString(value.dimension_id), sourceDimensionId = optionalString(value.source_dimension_id);
      return { key: boundedStoredString(value.group_key, "group_key", 16384), sourceId: boundedStoredString(value.source_id, "source_id", 500),
        status: value.status as IncomeAttributionStatus, ...(dimensionId === undefined ? {} : { dimensionId }),
        ...(sourceDimensionId === undefined ? {} : { sourceDimensionId }), ...totals(value) };
    });
    const last = items[items.length - 1];
    return { items, periodStart: filters.periodStart, periodEnd: filters.periodEnd, accountingBasis: basis, currencyCode: book.currencyCode,
      dimensionKind, revision, groupCount: string(row.summary.group_count, "group_count"), summary: totals(row.summary),
      coverage: { assigned: totals(row.coverage.assigned), unassigned: totals(row.coverage.unassigned), ambiguous: totals(row.coverage.ambiguous) },
      selection: { sort: sort ?? "identity", ...(attributionStatus ? { attributionStatus } : {}), ...(reference ? { reference } : {}) },
      matched: { ...totals(row.matched), groupCount: string(row.matched.group_count, "group_count") },
      ...(row.items.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind, scope: fingerprint, key: last.key, revision,
        ...(amountColumn ? { amount: sort === "cost_desc" ? last.costOfGoodsSold : last.income } : {}) })).toString("base64url") } : {}) };
  });
}

// Match the public operational-account source identity bound on requests and cursors.
const JOURNAL_IDENTITY_MAX_LENGTH = 500;

function journalOriginGroups(value: unknown): readonly JournalOriginGroup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new ErpFinancialsError("invalid_input", "Origin groups must contain 1 to 20 rules");
  const ids = new Set<string>();
  return value.map((item: unknown): JournalOriginGroup => {
    if (!isRecord(item) || Object.keys(item).some(key => !["id", "originModules", "transactionTypeContains"].includes(key))) throw new ErpFinancialsError("invalid_input", "Origin group rule is invalid");
    const id = readFilterText(item.id as string, "origin group id", 80);
    if (!id || id === "unclassified" || ids.has(id)) throw new ErpFinancialsError("invalid_input", "Origin group IDs must be unique and not reserved");
    ids.add(id);
    const terms = (raw: unknown): readonly string[] => {
      if (!Array.isArray(raw) || raw.length > 20) throw new ErpFinancialsError("invalid_input", "Origin group terms must be bounded arrays");
      return raw.map((term: unknown) => {
        const normalized = readFilterText(term as string, "origin group term", 100);
        if (!normalized) throw new ErpFinancialsError("invalid_input", "Origin group terms must be nonempty");
        return normalized;
      });
    };
    const originModules = terms(item.originModules), transactionTypeContains = terms(item.transactionTypeContains);
    if (originModules.length + transactionTypeContains.length === 0) throw new ErpFinancialsError("invalid_input", "Origin group rule requires a match term");
    return { id, originModules, transactionTypeContains };
  });
}

/** Only validated rule positions affect SQL text. Rule values remain in $17. */
function journalOriginGroupExpression(groups: readonly JournalOriginGroup[] | undefined): string {
  if (!groups) return "null::text";
  const module = "transaction.source_payload_ref->'preview'->'journalOrigin'->>'module'";
  const moduleCases = groups.map((_group, index) => `when ($17::jsonb->${String(index)}->'originModules') ? (${module}) then $17::jsonb->${String(index)}->>'id'`).join(" ");
  const typeCases = groups.flatMap((group, index) => group.transactionTypeContains.length === 0 ? [] : [
    `when (${group.transactionTypeContains.map((_term, termIndex) => `strpos(lower(transaction.source_transaction_type),lower($17::jsonb->${String(index)}->'transactionTypeContains'->>${String(termIndex)}))>0`).join(" or ")}) then $17::jsonb->${String(index)}->>'id'`,
  ]).join(" ");
  return `case when nullif(${module},'') is not null then case ${moduleCases} else 'unclassified' end else ${typeCases ? `case ${typeCases} else 'unclassified' end` : "'unclassified'"} end`;
}

function readJournalReport(scope: Scope, raw: JournalRegisterRequest): Promise<JournalRegisterPage>;
function readJournalReport(scope: Scope, raw: JournalPostingRequest, detail: true): Promise<JournalPostingPage>;
async function readJournalReport(scope: Scope, raw: JournalRegisterRequest | JournalPostingRequest, detail = false): Promise<JournalRegisterPage | JournalPostingPage> {
  assertWindow(raw.periodStart, raw.periodEnd);
  assertReportAccountingMethod(raw.accountingMethod);
  if (raw.includeIncomeEffect !== undefined && typeof raw.includeIncomeEffect !== "boolean") throw new ErpFinancialsError("invalid_input", "includeIncomeEffect must be boolean");
  const includeIncomeEffect = raw.includeIncomeEffect === true;
  const register = raw as JournalRegisterRequest, posting = raw as JournalPostingRequest;
  const sourceId = readFilterText(raw.sourceId, "sourceId", JOURNAL_IDENTITY_MAX_LENGTH);
  const transactionId = detail ? readFilterText(posting.transactionId, "transactionId", JOURNAL_IDENTITY_MAX_LENGTH) : undefined;
  if (detail && (!sourceId || !transactionId)) throw new ErpFinancialsError("invalid_input", "Journal detail requires sourceId and transactionId");
  const originGroups = detail ? undefined : journalOriginGroups(register.originGroups);
  const originGroupId = detail ? undefined : readFilterText(register.originGroupId, "originGroupId", 80);
  if (originGroupId !== undefined && (!originGroups || (originGroupId !== "unclassified" && !originGroups.some(group => group.id === originGroupId)))) throw new ErpFinancialsError("invalid_input", "Origin group filter requires a configured group");
  const filters = { periodStart: raw.periodStart, periodEnd: raw.periodEnd,
    ...(includeIncomeEffect ? { includeIncomeEffect: true } : {}),
    ...(raw.accountingMethod === undefined ? {} : { accountingMethod: raw.accountingMethod }),
    ...(originGroups === undefined ? {} : { originGroups }), ...(originGroupId === undefined ? {} : { originGroupId }),
    reference: detail ? undefined : readFilterText(register.reference, "reference", 512),
    sourceId, transactionId, transactionType: detail ? undefined : readFilterText(register.transactionType, "transactionType", 200),
    originModule: detail ? undefined : readFilterText(register.originModule, "originModule", 100),
    search: detail ? undefined : readFilterText(register.search, "search", 100) };
  // Avoid rescanning/materializing the same million-row set for identical controls.
  // Origin groups partition matching rows exactly once, so selected totals can
  // sum their disjoint controls without another copy of the journal rows.
  const hasMetadataFilter = filters.transactionType !== undefined || filters.originModule !== undefined || filters.search !== undefined || filters.reference !== undefined;
  const hasRowFilter = filters.sourceId !== undefined || hasMetadataFilter;
  const kind = detail ? "journal-postings" : "journal-register";
  const { limit } = pageInput({ ...(raw.limit === undefined ? {} : { limit: raw.limit }) }, kind, scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, kind, filters])).digest("hex");
  let boundaryDate: string | undefined, boundarySource: string | undefined, boundaryId: string | undefined, expectedRevision: string | undefined;
  if (raw.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (typeof raw.cursor !== "string" || raw.cursor.length > 8192) throw new Error();
      cursor = JSON.parse(Buffer.from(raw.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Journal cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== kind || cursor.scope !== fingerprint ||
      typeof cursor.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(cursor.date) ||
      typeof cursor.source !== "string" || !cursor.source || cursor.source.length > JOURNAL_IDENTITY_MAX_LENGTH ||
      typeof cursor.id !== "string" || !cursor.id || cursor.id.length > JOURNAL_IDENTITY_MAX_LENGTH ||
      typeof cursor.revision !== "string" || !/^[0-9a-f]{64}$/u.test(cursor.revision)) {
      throw new ErpFinancialsError("invalid_input", "Journal cursor does not belong to this scope and filters");
    }
    assertWindow(cursor.date, cursor.date);
    boundaryDate = cursor.date; boundarySource = cursor.source; boundaryId = cursor.id; expectedRevision = cursor.revision;
  }
  const incomeSum = includeIncomeEffect ? ',coalesce(sum(net_income_effect),0)::text "netIncomeEffect"' : "";
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope), basis = filters.accountingMethod ?? book.accountingBasis;
    // Aggregate postings once. Lifecycle enrichment is performed only after selecting
    // the bounded page, never as a correlated query for every journal in the book.
    const result = await client.query(`with journal_posted as materialized (
  select posting.source_id,posting.transaction_id,min(posting.posting_date) first_posting_date,max(posting.posting_date) last_posting_date,
    count(*) posting_count,sum(posting.debit_amount) debit_amount,sum(posting.credit_amount) credit_amount,
    bool_or(posting.debit_amount<>trunc(posting.debit_amount,2) or posting.credit_amount<>trunc(posting.credit_amount,2) or posting.net_amount<>trunc(posting.net_amount,2)) invalid_precision
    ${includeIncomeEffect ? `,sum(${journalIncomeEffectSql("coalesce(book_account.classification,account.classification)")}) net_income_effect` : ""}
  from erp_financials.ledger_postings posting
  ${includeIncomeEffect ? `join erp_financials.accounts account on account.tenant_id=posting.tenant_id and account.source_id=posting.source_id and account.account_id=posting.account_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  left join erp_financials.reporting_book_accounts book_account on book_account.tenant_id=$1 and book_account.company_id=$2 and book_account.book_id=$3 and book_account.book_account_key=mapping.book_account_key` : ""}
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date) and (source.effective_through is null or source.effective_through>=posting.posting_date)
  where posting.tenant_id=$1 and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date between $6::date and $7::date
    and ($9::text is null or (posting.source_id=$8 and posting.transaction_id=$9))
  group by posting.source_id,posting.transaction_id
), categorized as (
  select posted.*,${journalOriginGroupExpression(originGroups)} origin_group from journal_posted posted
  ${originGroups ? "left join erp_financials.transactions transaction on transaction.tenant_id=$1 and transaction.source_id=posted.source_id and transaction.transaction_id=posted.transaction_id" : ""}
), matching as ${originGroups || hasMetadataFilter ? "materialized" : "not materialized"} (
  select posted.* from categorized posted where ($8::text is null or source_id=$8)
    and (($10::text is null and $11::text is null and $12::text is null and $19::text is null) or exists (
      select 1 from erp_financials.transactions transaction where transaction.tenant_id=$1 and transaction.source_id=posted.source_id and transaction.transaction_id=posted.transaction_id
        and ($10::text is null or transaction.source_transaction_type=$10)
        and ($11::text is null or transaction.source_payload_ref->'preview'->'journalOrigin'->>'module'=$11)
        and ($12::text is null or strpos(lower(concat_ws(' ',transaction.transaction_number,transaction.memo,transaction.transaction_id,transaction.source_transaction_id)),lower($12))>0)
        and ($19::text is null or $19::text in (transaction.transaction_id,transaction.transaction_number,transaction.source_transaction_id))
    ))
), filtered as not materialized (
  select * from matching where ($18::text is null or origin_group=$18)
), origin_group_totals as (
  select origin_group id,count(*)::text "journalCount",sum(posting_count)::text "postingCount",sum(debit_amount)::text "debitAmount",sum(credit_amount)::text "creditAmount"${incomeSum}
  from matching where $17::jsonb is not null group by origin_group
), configured_groups as (
  select rule->>'id' id,ordinality ordinal from jsonb_array_elements($17::jsonb) with ordinality rules(rule,ordinality)
  union all select 'unclassified',21 where $17::jsonb is not null
), origin_groups as (
  select configured.id,configured.ordinal,coalesce(totals."journalCount",'0') "journalCount",coalesce(totals."postingCount",'0') "postingCount",
    coalesce(totals."debitAmount",'0') "debitAmount",coalesce(totals."creditAmount",'0') "creditAmount"${includeIncomeEffect ? ',coalesce(totals."netIncomeEffect",\'0\') "netIncomeEffect"' : ""}
  from configured_groups configured left join origin_group_totals totals using(id)
), selected as materialized (
  select * from filtered where ($9::text is not null or $13::date is null or (last_posting_date,source_id,transaction_id)<($13::date,$14::text,$15::text))
  order by last_posting_date desc,source_id desc,transaction_id desc limit $16
), headers as (
  select selected.*,transaction.transaction_date::text document_date,selected.first_posting_date::text first_date,selected.last_posting_date::text last_date,
    transaction.source_transaction_id,transaction.source_transaction_type,transaction.transaction_number,transaction.status document_status,transaction.memo,transaction.source_payload_ref,
    selected.posting_count::text count_text,selected.debit_amount::text debit_text,selected.credit_amount::text credit_text,
    ${includeIncomeEffect ? "selected.net_income_effect::text income_text," : ""}
    source.source_role,accounting_source.source_system,accounting_source.provider_environment,
    to_jsonb(prepared) preparer,
    case when links.replaced then 'replaced' when links.corrected then 'corrected'
      when links.voided then 'voided' when links.reversed then 'reversed' when prepared.event_id is not null then 'posted' else null end native_status
  from selected
  join erp_financials.transactions transaction on transaction.tenant_id=$1 and transaction.source_id=selected.source_id and transaction.transaction_id=selected.transaction_id
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=selected.source_id
  join erp_financials.accounting_sources accounting_source on accounting_source.tenant_id=$1 and accounting_source.source_id=selected.source_id
  left join lateral (
    select event.* from erp_financials.financial_lifecycle_events event where event.tenant_id=$1 and event.company_id=$2 and event.source_id=selected.source_id
      and event.aggregate_type='journal_entry' and event.aggregate_id=selected.transaction_id and event.event_type in ('journal_entry.posted','journal_entry.adjustment_posted')
    order by event.occurred_at,event.recorded_at,event.event_id limit 1
  ) prepared on true
  left join lateral (
    select bool_or(link_type='replacement') replaced,bool_or(link_type='correction') corrected,bool_or(link_type='void') voided,bool_or(link_type='reversal') reversed
    from erp_financials.journal_entry_links where tenant_id=$1 and company_id=$2 and source_id=selected.source_id and original_transaction_id=selected.transaction_id
  ) links on true
), summary as (
  select count(*)::text "journalCount",coalesce(sum(posting_count),0)::text "postingCount",coalesce(sum(debit_amount),0)::text "debitAmount",coalesce(sum(credit_amount),0)::text "creditAmount"${incomeSum} from journal_posted
), matched as (
  ${originGroups ? `select coalesce(sum("journalCount"::numeric),0)::text "journalCount",coalesce(sum("postingCount"::numeric),0)::text "postingCount",
    coalesce(sum("debitAmount"::numeric),0)::text "debitAmount",coalesce(sum("creditAmount"::numeric),0)::text "creditAmount"${includeIncomeEffect ? ',coalesce(sum("netIncomeEffect"::numeric),0)::text "netIncomeEffect"' : ""}
    from origin_group_totals where $18::text is null or id=$18` : hasRowFilter ? `select count(*)::text "journalCount",coalesce(sum(posting_count),0)::text "postingCount",coalesce(sum(debit_amount),0)::text "debitAmount",coalesce(sum(credit_amount),0)::text "creditAmount"${incomeSum} from filtered` : "select * from summary"}
), selected_postings as materialized (
  select posting.* from erp_financials.ledger_postings posting
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date) and (source.effective_through is null or source.effective_through>=posting.posting_date)
  where $9::text is not null and posting.tenant_id=$1 and posting.source_id=$8 and posting.transaction_id=$9
    and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date between $6::date and $7::date
    and ($13::date is null or (posting.posting_date,posting.source_id,posting.posting_id)<($13::date,$14::text,$15::text))
  order by posting.posting_date desc,posting.source_id desc,posting.posting_id desc limit $16
), lines as (
  select posting.posting_id,posting.source_id,posting.transaction_id,posting.source_posting_id,posting.posting_date::text,posting.accounting_basis,
    posting.account_id,posting.party_id,posting.item_id,posting.currency_code,posting.dimension_refs,
    posting.debit_amount::text,posting.credit_amount::text,posting.net_amount::text,
    transaction.transaction_number,transaction.transaction_date::text,transaction.source_transaction_type,transaction.source_transaction_id,transaction.source_payload_ref,
    account.account_number,account.name account_name,line.description,posting.transaction_line_id,line.line_number transaction_line_number,
    ${includeIncomeEffect ? `coalesce(book_account.classification,account.classification) income_classification,(${journalIncomeEffectSql("coalesce(book_account.classification,account.classification)")})::text income_text,` : ""}
    coalesce(mapping.book_account_key,posting.source_id||':'||posting.account_id) book_account_key,
    source.source_role,accounting_source.source_system,accounting_source.provider_environment
  from selected_postings posting
  join erp_financials.transactions transaction on transaction.tenant_id=$1 and transaction.source_id=posting.source_id and transaction.transaction_id=posting.transaction_id
  join erp_financials.accounts account on account.tenant_id=$1 and account.source_id=posting.source_id and account.account_id=posting.account_id
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
  join erp_financials.accounting_sources accounting_source on accounting_source.tenant_id=$1 and accounting_source.source_id=posting.source_id
  left join erp_financials.transaction_lines line on line.tenant_id=$1 and line.source_id=posting.source_id and line.transaction_line_id=posting.transaction_line_id and line.transaction_id=posting.transaction_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  ${includeIncomeEffect ? "left join erp_financials.reporting_book_accounts book_account on book_account.tenant_id=$1 and book_account.company_id=$2 and book_account.book_id=$3 and book_account.book_account_key=mapping.book_account_key" : ""}
), revision as (
${ACCOUNT_REPORT_REVISION_SQL}
)
select (select to_jsonb(summary) from summary) summary,(select to_jsonb(matched) from matched) matched,
  coalesce((select jsonb_agg(to_jsonb(origin_groups) order by ordinal) from origin_groups),'[]'::jsonb) origin_groups,
  coalesce((select jsonb_agg(to_jsonb(headers) order by last_posting_date desc,source_id desc,transaction_id desc) from headers),'[]'::jsonb) headers,
  coalesce((select jsonb_agg(to_jsonb(lines) order by posting_date desc,source_id desc,posting_id desc) from lines),'[]'::jsonb) lines,
  exists(select 1 from journal_posted where invalid_precision) invalid_precision,
  (select count(*) from selected)<>(select count(*) from headers) missing_transaction,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status) from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book,
  revision.revision from revision`,
      [scope.tenantId, scope.companyId, scope.bookId, basis, book.currencyCode, filters.periodStart, filters.periodEnd,
        filters.sourceId, filters.transactionId, filters.transactionType, filters.originModule, filters.search, boundaryDate, boundarySource, boundaryId, limit + 1,
        originGroups === undefined ? null : JSON.stringify(originGroups), originGroupId, filters.reference]);
    const row = requiredRow(result.rows[0], "journal report");
    if (!isRecord(row.current_book) || row.current_book.status !== "active" || row.current_book.currency !== book.currencyCode ||
      (filters.accountingMethod === undefined && row.current_book.basis !== book.accountingBasis)) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during journal read; reload");
    if (row.invalid_precision === true) throw new ErpFinancialsError("invalid_input", "Journal report contains unsupported sub-cent accounting amounts");
    if (row.missing_transaction === true) throw new ErpFinancialsError("invalid_input", "Posted journal is missing its canonical transaction");
    const revision = string(row.revision, "revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Accounting changed during pagination; reload journal from its first page");
    const records = (value: unknown): Record<string, unknown>[] => {
      if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error("Invalid stored journal report rows");
      return value as Record<string, unknown>[];
    };
    const headers = records(row.headers).map(journalRegisterItem);
    const common = { periodStart: filters.periodStart, periodEnd: filters.periodEnd, accountingBasis: basis, currencyCode: book.currencyCode, revision };
    const next = (date: string, source: string, id: string): string => {
      if (source.length > JOURNAL_IDENTITY_MAX_LENGTH || id.length > JOURNAL_IDENTITY_MAX_LENGTH) {
        throw new ErpFinancialsError("invalid_input", "Journal continuation identity exceeds the supported report bound");
      }
      return Buffer.from(JSON.stringify({ v: 1, kind, scope: fingerprint, date, source, id, revision })).toString("base64url");
    };
    if (detail) {
      const journal = headers[0];
      if (!journal) throw new ErpFinancialsError("missing_document", "No posted journal exists in this book and posting window");
      const lines = records(row.lines), items = lines.slice(0, limit).map(line => ({ ...ledgerLineFromRow(line), ...(includeIncomeEffect ? {
        accountClassification: string(line.income_classification, "income_classification") as AccountClassification,
        netIncomeEffect: registerMoney(line.income_text, "income_text"),
      } : {}) })), last = items[items.length - 1];
      return { ...common, journal, items, ...(lines.length > limit && last ? { nextCursor: next(last.postingDate, last.sourceId, last.postingId) } : {}) };
    }
    const totals = (value: unknown): JournalRegisterTotals => {
      if (!isRecord(value)) throw new Error("Invalid stored journal report controls");
      return { journalCount: string(value.journalCount, "journalCount"), postingCount: string(value.postingCount, "postingCount"),
        debitAmount: registerMoney(value.debitAmount, "debitAmount"), creditAmount: registerMoney(value.creditAmount, "creditAmount"),
        ...(includeIncomeEffect ? { netIncomeEffect: registerMoney(value.netIncomeEffect, "netIncomeEffect") } : {}) };
    };
    const items = headers.slice(0, limit), last = items[items.length - 1];
    return { ...common, summary: totals(row.summary), matched: totals(row.matched), items,
      ...(originGroups === undefined ? {} : { originGroups: records(row.origin_groups).map(group => ({ id: string(group.id, "origin group id"), ...totals(group) })) }),
      ...(headers.length > limit && last ? { nextCursor: next(last.lastPostingDate, last.sourceId, last.transactionId) } : {}) };
  });
}

/** Same effective classification/sign rules as getFinancialStatement(profit_and_loss).
 * Arguments are internal SQL aliases, never caller text. */
function journalIncomeEffectSql(classification: string): string {
  return `case when ${classification} in ('income','other_income','cost_of_goods_sold','expense','other_expense') then -posting.net_amount else 0 end`;
}

function journalRegisterItem(row: Record<string, unknown>): JournalRegisterItem {
  const sourceRef = optionalRecord(row.source_payload_ref, "source_payload_ref"), origin = journalOriginFromSourceRef(sourceRef);
  const number = optionalString(row.transaction_number), memo = optionalString(row.memo);
  return { transactionId: string(row.transaction_id, "transaction_id"), sourceId: string(row.source_id, "source_id"),
    transactionDate: date(row.document_date, "document_date"), firstPostingDate: date(row.first_date, "first_date"), lastPostingDate: date(row.last_date, "last_date"),
    documentStatus: string(row.document_status, "document_status"), ...(number === undefined ? {} : { transactionNumber: number }), ...(memo === undefined ? {} : { memo }),
    postingCount: string(row.count_text, "count_text"), debitAmount: registerMoney(row.debit_text, "debit_text"), creditAmount: registerMoney(row.credit_text, "credit_text"),
    ...(row.income_text == null ? {} : { netIncomeEffect: registerMoney(row.income_text, "income_text") }),
    sourceProvenance: { sourceId: string(row.source_id, "source_id"), sourceRole: reportingBookSourceRole(row.source_role),
      sourceSystem: boundedStoredString(row.source_system, "source_system", 200), providerEnvironment: boundedStoredString(row.provider_environment, "provider_environment", 100),
      sourceTransactionType: boundedStoredString(row.source_transaction_type, "source_transaction_type", 200), sourceTransactionId: boundedStoredString(row.source_transaction_id, "source_transaction_id", 300),
      ...sourceRefFields(sourceRef), ...(origin === undefined ? {} : { origin }) },
    ...(isRecord(row.preparer) ? { preparerProvenance: accountingLifecycleFromRow(row.preparer) } : {}),
    ...(row.native_status == null ? {} : { nativeStatus: string(row.native_status, "native_status") as JournalEntryStatus }),
    ...(row.origin_group == null ? {} : { originGroupId: string(row.origin_group, "origin_group") }) };
}

/** Shared definition space for chart pages and exact deep-link resolution.
 * Parameter positions are internal SQL constants, never caller input. */
function reportingAccountDefinitionsSql(asOfDateParameter: 4 | 7): string {
  return `  select book_account_key,account_number,name,classification,account_type,account_subtype,account_role,version,parent_book_account_key,active
  from erp_financials.reporting_book_accounts where tenant_id=$1 and company_id=$2 and book_id=$3
  union all
  select account.source_id||':'||account.account_id,account.account_number,account.name,account.classification,account.type,account.subtype,null,null,
    coalesce(parent_mapping.book_account_key,case when account.parent_account_id is null then null else account.source_id||':'||account.parent_account_id end),account.active
  from erp_financials.accounts account
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=account.source_id
    and (source.effective_from is null or source.effective_from<=$${String(asOfDateParameter)}::date)
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=account.source_id and mapping.account_id=account.account_id
  left join erp_financials.reporting_book_account_mappings parent_mapping on parent_mapping.tenant_id=$1 and parent_mapping.company_id=$2 and parent_mapping.book_id=$3 and parent_mapping.source_id=account.source_id and parent_mapping.account_id=account.parent_account_id
  where account.tenant_id=$1 and mapping.book_account_key is null`;
}

async function resolveReportingAccount(scope: Scope, raw: ReportingAccountReferenceRequest): Promise<ReportingAccountDefinition> {
  const referenceType = raw.referenceType, asOfDate = raw.asOfDate;
  if (!(["book_key", "account_number"] as readonly string[]).includes(referenceType)) throw new ErpFinancialsError("invalid_input", "Unsupported reporting account reference type");
  const reference = readFilterText(raw.reference, "reference", 512);
  if (!reference) throw new ErpFinancialsError("invalid_input", "Reporting account reference is required");
  assertWindow(asOfDate, asOfDate);
  return scope.database.transaction(async client => {
    // Same definition space as the chart: book definitions plus unmapped source
    // definitions whose binding has begun. Ended sources remain historical.
    // All matching and ambiguity detection happen in one metadata SQL snapshot.
    const result = await client.query(`with definitions as (
${reportingAccountDefinitionsSql(4)}
), matched as (
  select * from definitions where (case when $5::text='book_key' then book_account_key else account_number end)=$6::text limit 2
)
select (select status from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) book_status,
  coalesce((select jsonb_agg(to_jsonb(matched)) from matched),'[]'::jsonb) items`,
      [scope.tenantId, scope.companyId, scope.bookId, asOfDate, referenceType, reference]);
    const row = requiredRow(result.rows[0], "reporting account reference");
    if (row.book_status !== "active") throw new ErpFinancialsError("missing_book", "Reporting book is unavailable");
    if (!Array.isArray(row.items) || row.items.some(item => !isRecord(item))) throw new Error("Invalid reporting account definitions");
    if (row.items.length > 1) throw new ErpFinancialsError("invalid_input", "Reporting account reference is ambiguous; use a unique book account key");
    if (row.items.length === 0) throw new ErpFinancialsError("missing_account", "Reporting account was not found in this book");
    return reportingAccountDefinition(row.items[0] as Record<string, unknown>);
  });
}

function reportingAccountDefinition(item: Record<string, unknown>): ReportingAccountDefinition {
  const accountNumber = optionalString(item.account_number), type = optionalString(item.account_type), subtype = optionalString(item.account_subtype),
    role = optionalString(item.account_role), parent = optionalString(item.parent_book_account_key);
  return { bookAccountKey: string(item.book_account_key, "book_account_key"), name: string(item.name, "name"),
    classification: string(item.classification, "classification") as AccountClassification, active: item.active === true,
    ...(accountNumber === undefined ? {} : { accountNumber }), ...(type === undefined ? {} : { type }), ...(subtype === undefined ? {} : { subtype }),
    ...(role === undefined ? {} : { accountRole: role as ReportingBookAccountRole }), ...(item.version == null ? {} : { version: integer(item.version, "version") }),
    ...(parent === undefined ? {} : { parentBookAccountKey: parent }) };
}

async function getAccountChart(scope: Scope, raw: AccountChartRequest): Promise<AccountChartPage> {
  assertWindow(raw.periodStart, raw.periodEnd);
  assertReportAccountingMethod(raw.accountingMethod);
  if (raw.classification !== undefined && !ACCOUNT_CHART_CLASSES.includes(raw.classification)) throw new ErpFinancialsError("invalid_input", "Unsupported account classification");
  if (raw.includeInactive !== undefined && typeof raw.includeInactive !== "boolean") throw new ErpFinancialsError("invalid_input", "includeInactive must be boolean");
  if (raw.search !== undefined && typeof raw.search !== "string") throw new ErpFinancialsError("invalid_input", "search must be a string");
  const search = readFilterText(raw.search, "search", 100);
  const filters = { periodStart: raw.periodStart, periodEnd: raw.periodEnd, includeInactive: raw.includeInactive ?? true,
    ...(raw.classification === undefined ? {} : { classification: raw.classification }), ...(search === undefined ? {} : { search }),
    ...(raw.accountingMethod === undefined ? {} : { accountingMethod: raw.accountingMethod }) };
  const { limit } = pageInput({ ...(raw.limit === undefined ? {} : { limit: raw.limit }) }, "account-chart", scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, filters])).digest("hex");
  let boundaryRank: number | undefined, boundaryNumber: string | undefined, boundaryKey: string | undefined, expectedRevision: string | undefined;
  if (raw.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (typeof raw.cursor !== "string" || raw.cursor.length > 8192) throw new Error();
      cursor = JSON.parse(Buffer.from(raw.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Chart cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "account-chart" || cursor.scope !== fingerprint ||
      typeof cursor.rank !== "number" || !Number.isInteger(cursor.rank) || cursor.rank < 1 || cursor.rank > 8 ||
      typeof cursor.number !== "string" || cursor.number.length > 512 || typeof cursor.key !== "string" || !cursor.key || cursor.key.length > 512 ||
      typeof cursor.revision !== "string" || !/^[0-9a-f]{64}$/u.test(cursor.revision)) {
      throw new ErpFinancialsError("invalid_input", "Chart cursor does not belong to this scope and filters");
    }
    boundaryRank = cursor.rank; boundaryNumber = cursor.number; boundaryKey = cursor.key; expectedRevision = cursor.revision;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope), basis = filters.accountingMethod ?? book.accountingBasis;
    const result = await client.query(`with recursive definitions as (
${reportingAccountDefinitionsSql(7)}
), posted as (
  select coalesce(mapping.book_account_key,posting.source_id||':'||posting.account_id) book_account_key,
    coalesce(sum(posting.net_amount) filter(where posting.posting_date<$6::date),0) opening_net,
    coalesce(sum(posting.debit_amount) filter(where posting.posting_date>=$6::date),0) debit_amount,
    coalesce(sum(posting.credit_amount) filter(where posting.posting_date>=$6::date),0) credit_amount,
    sum(posting.net_amount) closing_net,count(*) filter(where posting.posting_date>=$6::date) posting_count,
    bool_or(posting.debit_amount<>trunc(posting.debit_amount,2) or posting.credit_amount<>trunc(posting.credit_amount,2) or posting.net_amount<>trunc(posting.net_amount,2)) invalid_precision
  from erp_financials.ledger_postings posting
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date) and (source.effective_through is null or source.effective_through>=posting.posting_date)
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  where posting.tenant_id=$1 and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date<=$7::date
  group by coalesce(mapping.book_account_key,posting.source_id||':'||posting.account_id)
), direct_rows as (
  select definition.*,coalesce(posted.opening_net,0) opening_net,coalesce(posted.debit_amount,0) debit_amount,
    coalesce(posted.credit_amount,0) credit_amount,coalesce(posted.closing_net,0) closing_net,coalesce(posted.posting_count,0) posting_count,
    array_position(array['asset','liability','equity','income','cost_of_goods_sold','expense','other_income','other_expense'],definition.classification) class_rank,
    coalesce(definition.account_number,definition.book_account_key) sort_number
  from definitions definition left join posted using(book_account_key)
), descendants(ancestor,descendant) as (
  select parent_book_account_key,book_account_key from definitions where parent_book_account_key is not null
  union
  select path.ancestor,child.book_account_key from descendants path join definitions child on child.parent_book_account_key=path.descendant
), membership(ancestor,descendant) as (
  select book_account_key,book_account_key from definitions
  union select ancestor,descendant from descendants
), inclusive_rows as (
  select membership.ancestor book_account_key,sum(row.opening_net) opening_net,sum(row.debit_amount) debit_amount,sum(row.credit_amount) credit_amount,
    sum(row.closing_net) closing_net,sum(row.posting_count) posting_count
  from membership join direct_rows row on row.book_account_key=membership.descendant group by membership.ancestor
), summary as (
  select count(*)::text "accountCount",coalesce(sum(opening_net),0)::text "openingNet",coalesce(sum(debit_amount),0)::text "debitAmount",
    coalesce(sum(credit_amount),0)::text "creditAmount",coalesce(sum(closing_net),0)::text "closingNet",coalesce(sum(posting_count),0)::text "postingCount",
    coalesce(sum(greatest(closing_net,0)),0)::text "trialDebit",coalesce(sum(greatest(-closing_net,0)),0)::text "trialCredit"
  from direct_rows
), groups as (
  select classification,min(class_rank) class_rank,count(*)::text "accountCount",sum(opening_net)::text "openingNet",sum(debit_amount)::text "debitAmount",
    sum(credit_amount)::text "creditAmount",sum(closing_net)::text "closingNet",sum(posting_count)::text "postingCount"
  from direct_rows group by classification
), filtered as (
  select * from direct_rows where ($8::text is null or classification=$8)
    and ($9::text is null or strpos(lower(concat_ws(' ',account_number,name,book_account_key)),lower($9))>0)
    and ($10::boolean or active or opening_net<>0 or debit_amount<>0 or credit_amount<>0 or closing_net<>0)
), selected as (
  select * from filtered where ($11::int is null or (class_rank,sort_number,book_account_key)>($11::int,$12::text,$13::text))
  order by class_rank,sort_number,book_account_key limit $14
), items as (
  select selected.book_account_key,selected.account_number,selected.name,selected.classification,selected.account_type,selected.account_subtype,
    selected.account_role,selected.version,selected.parent_book_account_key,selected.active,selected.class_rank,selected.sort_number,
    jsonb_build_object('openingNet',selected.opening_net::text,'debitAmount',selected.debit_amount::text,'creditAmount',selected.credit_amount::text,
      'closingNet',selected.closing_net::text,'postingCount',selected.posting_count::text) direct,
    jsonb_build_object('openingNet',inclusive.opening_net::text,'debitAmount',inclusive.debit_amount::text,'creditAmount',inclusive.credit_amount::text,
      'closingNet',inclusive.closing_net::text,'postingCount',inclusive.posting_count::text) inclusive
  from selected join inclusive_rows inclusive using(book_account_key)
), revision as (
${ACCOUNT_REPORT_REVISION_SQL}
)
select (select to_jsonb(summary) from summary) summary,
  coalesce((select jsonb_agg(to_jsonb(groups) order by class_rank) from groups),'[]'::jsonb) groups,
  (select count(*)::text from filtered) matched_count,
  coalesce((select jsonb_agg(to_jsonb(items) order by class_rank,sort_number,book_account_key) from items),'[]'::jsonb) items,
  exists(select 1 from descendants where ancestor=descendant) has_cycle,
  exists(select 1 from definitions group by book_account_key having count(*)>1) ambiguous_identity,
  exists(select 1 from posted where invalid_precision) invalid_precision,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status) from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book,
  revision.revision from revision`,
      [scope.tenantId, scope.companyId, scope.bookId, basis, book.currencyCode, filters.periodStart, filters.periodEnd,
        filters.classification, filters.search, filters.includeInactive, boundaryRank, boundaryNumber, boundaryKey, limit + 1]);
    const row = requiredRow(result.rows[0], "account chart");
    if (!isRecord(row.current_book) || row.current_book.status !== "active" || row.current_book.currency !== book.currencyCode ||
      (filters.accountingMethod === undefined && row.current_book.basis !== book.accountingBasis)) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during chart read; reload the chart");
    if (row.ambiguous_identity === true) throw new ErpFinancialsError("invalid_input", "Account chart contains ambiguous book account identities");
    if (row.has_cycle === true) throw new ErpFinancialsError("invalid_input", "Account chart contains a hierarchy cycle");
    if (row.invalid_precision === true) throw new ErpFinancialsError("invalid_input", "Account chart contains unsupported sub-cent accounting amounts");
    const revision = string(row.revision, "revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Accounting changed during pagination; reload the chart from its first page");
    const records = (value: unknown, field: string): Record<string, unknown>[] => {
      if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error(`Invalid stored ${field}`);
      return value as Record<string, unknown>[];
    };
    const totals = (value: unknown): AccountChartTotals => {
      if (!isRecord(value)) throw new Error("Invalid stored account chart totals");
      return { openingNet: registerMoney(value.openingNet, "openingNet"), debitAmount: registerMoney(value.debitAmount, "debitAmount"),
        creditAmount: registerMoney(value.creditAmount, "creditAmount"), closingNet: registerMoney(value.closingNet, "closingNet"), postingCount: string(value.postingCount, "postingCount") };
    };
    const values = records(row.items, "chart items");
    const items = values.slice(0, limit).map((item): AccountChartItem => ({
      ...reportingAccountDefinition(item), direct: totals(item.direct), inclusive: totals(item.inclusive),
    }));
    if (!isRecord(row.summary)) throw new Error("Invalid stored chart summary");
    const last = values[items.length - 1];
    return { items, periodStart: filters.periodStart, periodEnd: filters.periodEnd, accountingBasis: basis, currencyCode: book.currencyCode,
      revision, matchedAccountCount: string(row.matched_count, "matched_count"), summary: { ...totals(row.summary),
        accountCount: string(row.summary.accountCount, "accountCount"), trialDebit: registerMoney(row.summary.trialDebit, "trialDebit"),
        trialCredit: registerMoney(row.summary.trialCredit, "trialCredit"), groups: records(row.groups, "chart groups").map(group => ({ ...totals(group),
          classification: string(group.classification, "classification") as AccountClassification, accountCount: string(group.accountCount, "accountCount") })) },
      ...(values.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "account-chart", scope: fingerprint,
        rank: integer(last.class_rank, "class_rank"), number: string(last.sort_number, "sort_number"), key: string(last.book_account_key, "book_account_key"), revision })).toString("base64url") } : {}) };
  });
}

async function getSourceAccountBalanceSummary(scope: Scope, raw: SourceAccountBalanceRequest): Promise<SourceAccountBalanceSummary> {
  const input=structuredClone(raw);
  const sourceId=ledgerFilterText(input.sourceId,"sourceId");
  if(!sourceId||!Array.isArray(input.accountIds)||input.accountIds.length<1||input.accountIds.length>200
    ||input.accountIds.some(id=>typeof id!=="string"||!id.trim()||id!==id.trim()||id.length>500)
    ||new Set(input.accountIds).size!==input.accountIds.length)throw new ErpFinancialsError("invalid_input","Exact source account balances require 1–200 distinct account IDs");
  assertReportAccountingMethod(input.accountingMethod);
  return scope.database.transaction(async client=>{
    const book=await resolveBook(client,scope),basis=input.accountingMethod??book.accountingBasis;
    const rows=(await client.query(`select a.account_id,a.source_account_id,a.account_number,a.classification,a.type,
 b.base_currency_code,b.accounting_basis,b.status,totals.debits::text,totals.credits::text,totals.net::text,totals.postings::text,totals.invalid_precision
from erp_financials.accounts a
join erp_financials.reporting_book_sources bs on bs.tenant_id=a.tenant_id and bs.company_id=$2 and bs.book_id=$3 and bs.source_id=a.source_id
join erp_financials.reporting_books b on b.tenant_id=bs.tenant_id and b.company_id=bs.company_id and b.book_id=bs.book_id
cross join lateral(select coalesce(sum(p.debit_amount),0) debits,coalesce(sum(p.credit_amount),0) credits,
 coalesce(sum(p.net_amount),0) net,count(*) postings,coalesce(bool_or(p.debit_amount<>trunc(p.debit_amount,2) or p.credit_amount<>trunc(p.credit_amount,2) or p.net_amount<>trunc(p.net_amount,2)),false) invalid_precision
 from erp_financials.ledger_postings p where p.tenant_id=a.tenant_id and p.source_id=a.source_id and p.account_id=a.account_id
 and p.accounting_basis=$5 and p.currency_code=$6
 and (bs.effective_from is null or bs.effective_from<=p.posting_date) and (bs.effective_through is null or bs.effective_through>=p.posting_date)) totals
where a.tenant_id=$1 and a.source_id=$4 and a.account_id=any($7::text[]) order by a.account_id`,
      [scope.tenantId,scope.companyId,scope.bookId,sourceId,basis,book.currencyCode,input.accountIds])).rows;
    if(rows.length!==input.accountIds.length)throw new ErpFinancialsError("missing_account","A requested source account is outside this reporting book");
    const items=rows.map(row=>{
      if(row.status!=="active"||row.base_currency_code!==book.currencyCode||(input.accountingMethod===undefined&&row.accounting_basis!==basis))throw new ErpFinancialsError("optimistic_concurrency_conflict","Reporting book changed during account balance read");
      if(row.invalid_precision===true)throw new ErpFinancialsError("invalid_input","Source account contains unsupported sub-cent accounting amounts");
      const accountNumber=optionalString(row.account_number),postingCount=string(row.postings,"postings");
      if(!/^(0|[1-9]\d*)$/u.test(postingCount))throw new ErpFinancialsError("invalid_input","Invalid account posting count");
      return {accountId:string(row.account_id,"account_id"),sourceAccountId:string(row.source_account_id,"source_account_id"),...(accountNumber===undefined?{}:{accountNumber}),
        classification:string(row.classification,"classification") as AccountClassification,accountType:string(row.type,"type"),
        debitAmount:registerMoney(row.debits,"debits"),creditAmount:registerMoney(row.credits,"credits"),netAmount:registerMoney(row.net,"net"),postingCount};
    });
    return {sourceId,accountingBasis:basis,currencyCode:book.currencyCode,items};
  });
}

async function getAccountRegister(scope: Scope, raw: AccountRegisterRequest): Promise<AccountRegisterPage> {
  assertWindow(raw.periodStart, raw.periodEnd);
  assertReportAccountingMethod(raw.accountingMethod);
  if (typeof raw.accountKey !== "string" || !raw.accountKey.trim() || raw.accountKey.trim().length > 512) throw new ErpFinancialsError("invalid_input", "accountKey is required and bounded");
  if (raw.includeDescendants !== undefined && typeof raw.includeDescendants !== "boolean") throw new ErpFinancialsError("invalid_input", "includeDescendants must be boolean");
  const sourceId = ledgerFilterText(raw.sourceId, "sourceId");
  const filters = { accountKey: raw.accountKey.trim(), periodStart: raw.periodStart, periodEnd: raw.periodEnd,
    includeDescendants: raw.includeDescendants ?? false,
    ...(sourceId === undefined ? {} : { sourceId }), ...(raw.accountingMethod === undefined ? {} : { accountingMethod: raw.accountingMethod }) };
  const kind = `account-register:${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, filters])).digest("hex")}`;
  if (raw.cursor !== undefined && (typeof raw.cursor !== "string" || raw.cursor.length > 8192)) throw new ErpFinancialsError("invalid_input", "Register cursor is invalid");
  const page = pageInput(raw, kind, scope.bookId);
  let expectedRevision: string | undefined;
  if (raw.cursor !== undefined) {
    const cursor: unknown = JSON.parse(Buffer.from(raw.cursor, "base64url").toString("utf8"));
    if (!isRecord(cursor) || typeof cursor.revision !== "string" || !/^[0-9a-f]{64}$/u.test(cursor.revision)
      || page.date === undefined || page.date < filters.periodStart || page.date > filters.periodEnd || !page.id || page.id.length > 1000) {
      throw new ErpFinancialsError("invalid_input", "Register cursor does not contain a valid revision and boundary");
    }
    expectedRevision = cursor.revision;
  }
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope), basis = filters.accountingMethod ?? book.accountingBasis;
    // Summary, cursor prefix, bounded rows and revision all share one PostgreSQL
    // statement snapshot. Only the page is windowed or materialized; no complete
    // ledger, running balance or client-supplied amount is loaded into JS.
    const result = await client.query(
      `with recursive effective_accounts as (
  select account.tenant_id,account.source_id,account.account_id,
    coalesce(mapping.book_account_key,account.source_id || ':' || account.account_id) book_account_key,
    case when mapping.book_account_key is not null then book_account.parent_book_account_key
      else coalesce(parent_mapping.book_account_key,case when parent.account_id is null then null else parent.source_id || ':' || parent.account_id end) end parent_book_account_key
  from erp_financials.accounts account
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=account.source_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=account.source_id and mapping.account_id=account.account_id
  left join erp_financials.reporting_book_accounts book_account on book_account.tenant_id=$1 and book_account.company_id=$2 and book_account.book_id=$3 and book_account.book_account_key=mapping.book_account_key
  left join erp_financials.accounts parent on parent.tenant_id=account.tenant_id and parent.source_id=account.source_id and parent.account_id=account.parent_account_id
  left join erp_financials.reporting_book_account_mappings parent_mapping on parent_mapping.tenant_id=$1 and parent_mapping.company_id=$2 and parent_mapping.book_id=$3 and parent_mapping.source_id=parent.source_id and parent_mapping.account_id=parent.account_id
  where account.tenant_id=$1
), account_hierarchy as (
  select book_account_key,parent_book_account_key from effective_accounts
  union
  select book_account_key,parent_book_account_key from erp_financials.reporting_book_accounts where tenant_id=$1 and company_id=$2 and book_id=$3
), selected_keys(book_account_key) as (
  select $8::text
  union
  select account.book_account_key from account_hierarchy account join selected_keys selected on account.parent_book_account_key=selected.book_account_key where $13::boolean
), definition as (
  select account_number,name,classification,active from erp_financials.reporting_book_accounts where tenant_id=$1 and company_id=$2 and book_id=$3 and book_account_key=$8
  union all
  select account.account_number,account.name,account.classification,account.active from effective_accounts e
  join erp_financials.accounts account on account.tenant_id=e.tenant_id and account.source_id=e.source_id and account.account_id=e.account_id
  where e.book_account_key=$8 and not exists(select 1 from erp_financials.reporting_book_accounts where tenant_id=$1 and company_id=$2 and book_id=$3 and book_account_key=$8)
), scoped as not materialized (
  select posting.* from erp_financials.ledger_postings posting
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
    and (source.effective_from is null or source.effective_from<=posting.posting_date)
    and (source.effective_through is null or source.effective_through>=posting.posting_date)
  join effective_accounts account on account.tenant_id=posting.tenant_id and account.source_id=posting.source_id and account.account_id=posting.account_id
  where posting.tenant_id=$1 and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date<=$7::date
    and account.book_account_key in(select book_account_key from selected_keys)
    and ($9::text is null or posting.source_id=$9)
), summary as (
  select coalesce(sum(net_amount) filter(where posting_date<$6::date),0) opening_net,
    coalesce(sum(debit_amount) filter(where posting_date>=$6::date),0) debit_amount,
    coalesce(sum(credit_amount) filter(where posting_date>=$6::date),0) credit_amount,
    coalesce(sum(net_amount),0) closing_net,
    count(*) filter(where posting_date>=$6::date)::text posting_count,
    coalesce(bool_or(debit_amount<>trunc(debit_amount,2) or credit_amount<>trunc(credit_amount,2) or net_amount<>trunc(net_amount,2)),false) invalid_precision,
    coalesce(sum(net_amount) filter(where posting_date<$6::date or ($10::date is not null and (posting_date,posting_id)<=($10::date,$11::text))),0) prefix_net
  from scoped
), page as materialized (
  -- Take at most K candidates per physical account using its ordered activity
  -- index, then merge K globally. This avoids sorting the full ledger a second
  -- time for the page while preserving order across mapped sources/descendants.
  select posting.* from effective_accounts account
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=account.source_id
  cross join lateral (
    select posting.* from erp_financials.ledger_postings posting
    where posting.tenant_id=account.tenant_id and posting.source_id=account.source_id and posting.account_id=account.account_id
      and posting.accounting_basis=$4 and posting.currency_code=$5 and posting.posting_date between $6::date and $7::date
      and (source.effective_from is null or source.effective_from<=posting.posting_date)
      and (source.effective_through is null or source.effective_through>=posting.posting_date)
      and ($10::date is null or (posting.posting_date,posting.posting_id)>($10::date,$11::text))
    order by posting.posting_date,posting.posting_id limit $12
  ) posting
  where account.book_account_key in(select book_account_key from selected_keys) and ($9::text is null or account.source_id=$9)
  order by posting.posting_date,posting.posting_id limit $12
), running as (
  select page.*,summary.prefix_net+sum(page.net_amount) over(order by page.posting_date,page.posting_id rows unbounded preceding) running_net from page cross join summary
), revision as (
${ACCOUNT_REPORT_REVISION_SQL}
), enriched as (
  select posting.posting_id,posting.source_id,posting.source_posting_id,posting.transaction_id,
    transaction.source_transaction_id,transaction.source_transaction_type,transaction.transaction_number,transaction.memo,
    transaction.transaction_date::text transaction_date,posting.posting_date::text posting_date,posting.accounting_basis,posting.account_id,
    coalesce(mapping.book_account_key,posting.source_id || ':' || posting.account_id) book_account_key,
    account.account_number,account.name account_name,posting.party_id,posting.item_id,line.description,
    posting.debit_amount::text debit_amount,posting.credit_amount::text credit_amount,posting.net_amount::text net_amount,posting.running_net::text running_net,
    posting.currency_code,posting.dimension_refs,source.source_role,accounting_source.source_system,accounting_source.provider_environment,
    coalesce(posting.source_payload_ref,transaction.source_payload_ref) source_payload_ref
  from running posting
  join erp_financials.transactions transaction on transaction.tenant_id=posting.tenant_id and transaction.source_id=posting.source_id and transaction.transaction_id=posting.transaction_id
  join erp_financials.accounts account on account.tenant_id=posting.tenant_id and account.source_id=posting.source_id and account.account_id=posting.account_id
  join erp_financials.accounting_sources accounting_source on accounting_source.tenant_id=posting.tenant_id and accounting_source.source_id=posting.source_id
  join erp_financials.reporting_book_sources source on source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=posting.source_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=posting.source_id and mapping.account_id=posting.account_id
  left join erp_financials.transaction_lines line on line.tenant_id=posting.tenant_id and line.source_id=posting.source_id and line.transaction_line_id=posting.transaction_line_id
)
select definition.*,revision.revision,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status) from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book,
  summary.opening_net::text opening_net,summary.debit_amount::text debit_amount,summary.credit_amount::text credit_amount,
  summary.closing_net::text closing_net,summary.posting_count,summary.invalid_precision,
  coalesce((select jsonb_agg(to_jsonb(enriched) order by posting_date,posting_id) from enriched),'[]'::jsonb) items
from definition cross join summary cross join revision`,
      [scope.tenantId, scope.companyId, scope.bookId, basis, book.currencyCode, filters.periodStart, filters.periodEnd,
        filters.accountKey, filters.sourceId, page.date, page.id, page.limit + 1, filters.includeDescendants]
    );
    const row = result.rows[0];
    if (!row) throw new ErpFinancialsError("missing_document", "Ledger account is outside this reporting book");
    // resolveBook validates existence/active state before the financial query.
    // A concurrent book reconfiguration must not mix that earlier currency/basis
    // with newer financial facts under READ COMMITTED.
    if (!isRecord(row.current_book) || row.current_book.status !== "active" || row.current_book.currency !== book.currencyCode
      || (filters.accountingMethod === undefined && row.current_book.basis !== book.accountingBasis)) {
      throw new ErpFinancialsError("optimistic_concurrency_conflict", "Reporting book changed during register read; reload the register");
    }
    if (row.invalid_precision === true) throw new ErpFinancialsError("invalid_input", "Account register contains unsupported sub-cent accounting amounts");
    const revision = string(row.revision, "revision");
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new ErpFinancialsError("optimistic_concurrency_conflict", "Accounting changed during pagination; reload the register from its first page");
    if (!Array.isArray(row.items) || row.items.some(item => !isRecord(item))) throw new Error("Invalid stored register page");
    const values = row.items.map((item: Record<string, unknown>): AccountRegisterLine => {
      for (const field of ["debit_amount", "credit_amount", "net_amount"] as const) registerMoney(item[field], field);
      const memo = optionalString(item.memo);
      return { ...ledgerLineFromRow(item), runningNet: registerMoney(item.running_net, "running_net"), ...(memo === undefined ? {} : { memo }) };
    });
    const items = values.slice(0, page.limit), last = items.at(-1), accountNumber = optionalString(row.account_number);
    return {
      account: { bookAccountKey: filters.accountKey, name: string(row.name, "name"), classification: string(row.classification, "classification") as AccountClassification,
        active: row.active === true, ...(accountNumber === undefined ? {} : { accountNumber }) },
      periodStart: filters.periodStart, periodEnd: filters.periodEnd, accountingBasis: basis, currencyCode: book.currencyCode, revision,
      openingNet: registerMoney(row.opening_net, "opening_net"), debitAmount: registerMoney(row.debit_amount, "debit_amount"),
      creditAmount: registerMoney(row.credit_amount, "credit_amount"), closingNet: registerMoney(row.closing_net, "closing_net"),
      postingCount: string(row.posting_count, "posting_count"), items,
      ...(values.length > page.limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind, bookId: scope.bookId,
        date: last.postingDate, id: last.postingId, revision }), "utf8").toString("base64url") } : {})
    };
  });
}

/** This USD-style money contract must never silently truncate stored sub-cent
 * facts. Trailing SQL numeric zeroes are harmless; nonzero precision is not. */
function registerMoney(value: unknown, field: string): DecimalString {
  const amount = string(value, field);
  if (/[1-9]/u.test((amount.split(".")[1] ?? "").slice(2))) {
    throw new ErpFinancialsError("invalid_input", "Account register contains unsupported sub-cent accounting amounts", { details: { field } });
  }
  return money(amount, field);
}

async function getGeneralLedgerSummary(
  scope: Scope,
  input: GeneralLedgerFilters
): Promise<GeneralLedgerSummary> {
  const filters = generalLedgerFilters(input);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const accountingBasis = filters.accountingMethod ?? book.accountingBasis;
    const result = await client.query(
      `with recursive effective_accounts as (
  select account."tenant_id", account."source_id", account."account_id",
    coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id") as "book_account_key",
    case when mapping."book_account_key" is not null then book_account."parent_book_account_key"
      else coalesce(parent_mapping."book_account_key",
        case when parent_account."account_id" is null then null
          else parent_account."source_id" || ':' || parent_account."account_id" end)
    end as "parent_book_account_key"
  from "erp_financials"."accounts" account
  join "erp_financials"."reporting_book_sources" hierarchy_source
    on hierarchy_source."tenant_id" = $1 and hierarchy_source."company_id" = $2
   and hierarchy_source."book_id" = $3 and hierarchy_source."source_id" = account."source_id"
  left join "erp_financials"."reporting_book_account_mappings" mapping
    on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
   and mapping."source_id" = account."source_id" and mapping."account_id" = account."account_id"
  left join "erp_financials"."reporting_book_accounts" book_account
    on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
   and book_account."book_account_key" = mapping."book_account_key"
  left join "erp_financials"."accounts" parent_account
    on parent_account."tenant_id" = account."tenant_id" and parent_account."source_id" = account."source_id"
   and parent_account."account_id" = account."parent_account_id"
  left join "erp_financials"."reporting_book_account_mappings" parent_mapping
    on parent_mapping."tenant_id" = $1 and parent_mapping."company_id" = $2 and parent_mapping."book_id" = $3
   and parent_mapping."source_id" = parent_account."source_id" and parent_mapping."account_id" = parent_account."account_id"
  where account."tenant_id" = $1
), selected_account_keys("book_account_key") as (
  select $8::text where $8::text is not null
  union
  select account."book_account_key"
  from effective_accounts account
  join selected_account_keys selected
    on account."parent_book_account_key" = selected."book_account_key"
)
select count(*)::integer as "posting_count", coalesce(sum(posting."debit_amount"), 0) as "debits",
  coalesce(sum(posting."credit_amount"), 0) as "credits"
from "erp_financials"."ledger_postings" posting
join "erp_financials"."transactions" transaction
  on transaction."tenant_id" = posting."tenant_id" and transaction."source_id" = posting."source_id" and transaction."transaction_id" = posting."transaction_id"
join "erp_financials"."accounts" account
  on account."tenant_id" = posting."tenant_id" and account."source_id" = posting."source_id" and account."account_id" = posting."account_id"
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = posting."source_id"
 and (source."effective_from" is null or source."effective_from" <= posting."posting_date")
 and (source."effective_through" is null or source."effective_through" >= posting."posting_date")
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = posting."source_id" and mapping."account_id" = posting."account_id"
left join "erp_financials"."transaction_lines" line
  on line."tenant_id" = posting."tenant_id" and line."source_id" = posting."source_id" and line."transaction_line_id" = posting."transaction_line_id"
left join "erp_financials"."parties" party
  on party."tenant_id" = posting."tenant_id" and party."source_id" = posting."source_id" and party."party_id" = posting."party_id"
where posting."tenant_id" = $1 and posting."accounting_basis" = $4 and posting."currency_code" = $5
  and posting."posting_date" between $6::date and $7::date
  and ($8::text is null or coalesce(mapping."book_account_key", posting."source_id" || ':' || posting."account_id") in (
    select "book_account_key" from selected_account_keys
  ))
  and ($9::text is null or posting."source_id" = $9)
  and ($10::text is null or transaction."source_transaction_type" = $10)
  and ($11::text is null or exists (
    select 1 from jsonb_array_elements(coalesce(posting."dimension_refs", '[]'::jsonb)) class_ref
    where lower(class_ref ->> 'dimensionKind') = 'class'
      and (class_ref ->> 'dimensionId' = $11 or class_ref ->> 'sourceDimensionId' = $11)
  ))
  and ($12::text is null or exists (
    select 1 from jsonb_array_elements(coalesce(posting."dimension_refs", '[]'::jsonb)) dimension_ref
    where dimension_ref ->> 'dimensionKind' = $12
      and (dimension_ref ->> 'dimensionId' = $13 or dimension_ref ->> 'sourceDimensionId' = $13)
  ))
  and ($14::text is null or ($14 = 'debit' and posting."debit_amount" > 0) or ($14 = 'credit' and posting."credit_amount" > 0))
  and ($15::text is null or strpos(lower(concat_ws(' ', transaction."transaction_number", transaction."memo",
    line."description", account."account_number", account."name", party."display_name", posting."posting_id",
    transaction."transaction_id")), lower($15)) > 0)`,
      [scope.tenantId, scope.companyId, scope.bookId, accountingBasis, book.currencyCode,
        filters.periodStart, filters.periodEnd, filters.accountKey, filters.sourceId, filters.transactionType,
        filters.classId, filters.dimensionKind, filters.dimensionId, filters.polarity, filters.search]
    );
    const row = requiredRow(result.rows[0], "general ledger summary");
    const totalDebits = money(row.debits, "debits");
    const totalCredits = money(row.credits, "credits");
    return {
      periodStart: filters.periodStart,
      periodEnd: filters.periodEnd,
      accountingBasis,
      currencyCode: book.currencyCode,
      postingCount: integer(row.posting_count, "posting_count"),
      totalDebits,
      totalCredits,
      difference: subtractMoney(totalDebits, totalCredits)
    };
  });
}

async function listOperationalAccounts(scope: Scope, input: OperationalAccountListRequest): Promise<Page<OperationalAccountListItem>> {
  const sourceId = readFilterText(input.sourceId, "sourceId", 500), asOfDate = input.asOfDate;
  if (!sourceId) throw new ErpFinancialsError("invalid_input", "sourceId is required");
  assertDate(asOfDate, "asOfDate");
  if (input.includeUnavailable !== undefined && typeof input.includeUnavailable !== "boolean") throw new ErpFinancialsError("invalid_input", "includeUnavailable must be boolean");
  const search = readFilterText(input.search, "search", 100), includeUnavailable = input.includeUnavailable ?? false;
  const { limit } = pageInput({ ...(input.limit === undefined ? {} : { limit: input.limit }) }, "operational-accounts", scope.bookId);
  const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, sourceId, asOfDate, search, includeUnavailable])).digest("hex");
  let boundaryNumber: string | undefined, boundaryId: string | undefined;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 8192) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    } catch { throw new ErpFinancialsError("invalid_input", "Account selector cursor is invalid"); }
    if (!isRecord(cursor) || cursor.v !== 1 || cursor.kind !== "operational-accounts" || cursor.scope !== fingerprint ||
      typeof cursor.number !== "string" || cursor.number.length > 500 || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 500) {
      throw new ErpFinancialsError("invalid_input", "Account selector cursor does not belong to this scope and filters");
    }
    boundaryNumber = cursor.number; boundaryId = cursor.id;
  }
  // This is live metadata, not a balance/report snapshot or an eligibility lease.
  // Each page rechecks scope. Commands acquire lifecycle locks and revalidate.
  return scope.database.transaction(async client => {
    const result = await client.query(`with eligible_source as (
  select source.source_id from erp_financials.reporting_book_sources source
  join erp_financials.company_sources company on company.tenant_id=source.tenant_id and company.company_id=source.company_id and company.source_id=source.source_id
  where source.tenant_id=$1 and source.company_id=$2 and source.book_id=$3 and source.source_id=$4
    and (source.effective_from is null or source.effective_from<=$5::date) and (source.effective_through is null or source.effective_through>=$5::date)
), definitions as (
  select account.account_id,account.source_id,account.source_account_id,account.account_number,account.name,account.type,account.classification,account.active,
    coalesce(mapping.book_account_key,account.source_id||':'||account.account_id) book_account_key,
    coalesce(book_account.name,account.name) book_account_name,coalesce(book_account.account_number,account.account_number) book_account_number,
    account.active and (mapping.book_account_key is null or (book_account.active and book_account.account_role='posting')) account_enabled,
    coalesce(book_account.account_number,account.account_number,'') sort_number
  from eligible_source source join erp_financials.accounts account on account.tenant_id=$1 and account.source_id=source.source_id
  left join erp_financials.reporting_book_account_mappings mapping on mapping.tenant_id=$1 and mapping.company_id=$2 and mapping.book_id=$3 and mapping.source_id=account.source_id and mapping.account_id=account.account_id
  left join erp_financials.reporting_book_accounts book_account on book_account.tenant_id=$1 and book_account.company_id=$2 and book_account.book_id=$3 and book_account.book_account_key=mapping.book_account_key
), selected as (
  select * from definitions where ($6::boolean or account_enabled)
    and ($7::text is null or strpos(lower(concat_ws(' ',account_number,name,source_account_id,book_account_number,book_account_name,book_account_key)),lower($7))>0)
    and ($8::text is null or (sort_number,account_id)>($8::text,$9::text))
  order by sort_number,account_id limit $10
)
select (select status from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) book_status,
  exists(select 1 from eligible_source) source_available,
  coalesce((select jsonb_agg(to_jsonb(selected) order by sort_number,account_id) from selected),'[]'::jsonb) items`,
      [scope.tenantId, scope.companyId, scope.bookId, sourceId, asOfDate, includeUnavailable, search, boundaryNumber, boundaryId, limit + 1]);
    const row = requiredRow(result.rows[0], "operational accounts");
    if (row.book_status == null) throw new ErpFinancialsError("missing_book", "Reporting book does not exist");
    if (row.book_status !== "active") throw new ErpFinancialsError("scope_mismatch", "Reporting book is not active");
    if (row.source_available !== true) throw new ErpFinancialsError("scope_mismatch", "Account source is not bound to this company and book on the requested date");
    if (!Array.isArray(row.items) || row.items.some(value => !isRecord(value))) throw new Error("Invalid stored operational account definitions");
    const values = row.items as Record<string, unknown>[];
    const items = values.slice(0, limit).map((value): OperationalAccountListItem => {
      const accountNumber = optionalString(value.account_number), bookAccountNumber = optionalString(value.book_account_number);
      return { accountId: string(value.account_id, "account_id"), sourceId: string(value.source_id, "source_id"), sourceAccountId: string(value.source_account_id, "source_account_id"),
        name: string(value.name, "name"), type: string(value.type, "type"), classification: string(value.classification, "classification") as AccountClassification,
        active: value.active === true, accountEnabled: value.account_enabled === true,
        bookAccountKey: string(value.book_account_key, "book_account_key"), bookAccountName: string(value.book_account_name, "book_account_name"),
        ...(accountNumber === undefined ? {} : { accountNumber }), ...(bookAccountNumber === undefined ? {} : { bookAccountNumber }) };
    });
    const last = values[items.length - 1];
    return { items, ...(values.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, kind: "operational-accounts", scope: fingerprint,
      number: last.sort_number === "" ? "" : string(last.sort_number, "sort_number"), id: string(last.account_id, "account_id") })).toString("base64url") } : {}) };
  });
}

async function getOperationalAccountByKey(scope: Scope, input: OperationalAccountKeyRequest): Promise<OperationalAccountDefinition> {
  const { sourceId, accountKey, asOfDate } = input;
  if (typeof sourceId !== "string" || sourceId.length > 500 || typeof accountKey !== "string" || accountKey.length > 500) {
    throw new ErpFinancialsError("invalid_input", "Account lookup requires bounded source and account key identities");
  }
  assertNonEmpty(sourceId, "sourceId");
  assertNonEmpty(accountKey, "accountKey");
  return getOperationalAccount(scope, { sourceId, accountId: scopedRecordId({ tenantId: scope.tenantId, sourceId }, "account", accountKey), asOfDate });
}

async function getOperationalAccounts(scope: Scope, input: OperationalAccountsRequest): Promise<readonly OperationalAccountDefinition[]> {
  // Snapshot every caller-owned scalar/array before the first await.
  const request=input as OperationalAccountsRequest|null|undefined;
  const sourceId=request?.sourceId,asOfDate=request?.asOfDate,rawIds:unknown=request?.accountIds;
  if(typeof sourceId!=="string"||!sourceId.trim()||sourceId.length>500||typeof asOfDate!=="string"||!Array.isArray(rawIds)
    ||rawIds.length<1||rawIds.length>200||rawIds.some(id=>typeof id!=="string"||!id.trim()||id.length>500)||new Set(rawIds).size!==rawIds.length)
    throw new ErpFinancialsError("invalid_input","Account metadata requires a source, date and 1–200 distinct bounded account IDs");
  const accountIds=[...(rawIds as string[])];assertDate(asOfDate,"asOfDate");
  return scope.database.transaction(async client=>{
    await resolveBook(client,scope);
    const result=await client.query(`select account."account_id",account."source_id",account."source_account_id",account."account_number",account."name",account."type",account."classification",account."active"
      from "erp_financials"."accounts" account
      join "erp_financials"."reporting_book_sources" source
        on source."tenant_id"=account."tenant_id" and source."source_id"=account."source_id"
       and source."company_id"=$2 and source."book_id"=$3
       and (source."effective_from" is null or source."effective_from"<=$6::date)
       and (source."effective_through" is null or source."effective_through">=$6::date)
      where account."tenant_id"=$1 and account."source_id"=$4 and account."account_id"=any($5::text[])`,
      [scope.tenantId,scope.companyId,scope.bookId,sourceId,accountIds,asOfDate]);
    if(result.rows.length!==accountIds.length)throw new ErpFinancialsError("missing_account","A requested account is not available in this reporting book");
    const byId=new Map(result.rows.map(row=>[string(row.account_id,"account_id"),row]));
    return accountIds.map(id=>{
      const row=byId.get(id);if(!row)throw new ErpFinancialsError("missing_account","A requested account is not available in this reporting book");
      const accountNumber=optionalString(row.account_number);
      return {accountId:id,sourceId:string(row.source_id,"source_id"),sourceAccountId:string(row.source_account_id,"source_account_id"),
        name:string(row.name,"name"),type:string(row.type,"type"),classification:string(row.classification,"classification") as AccountClassification,
        active:row.active===true,...(accountNumber===undefined?{}:{accountNumber})};
    });
  });
}

async function getOperationalAccount(scope: Scope, input: OperationalAccountRequest): Promise<OperationalAccountDefinition> {
  // Read scalars before awaiting so caller mutation cannot change the lookup scope.
  const { sourceId, accountId, asOfDate } = input;
  if (typeof sourceId !== "string" || sourceId.length > 500 || typeof accountId !== "string" || accountId.length > 500 || typeof asOfDate !== "string") {
    throw new ErpFinancialsError("invalid_input", "Account lookup requires bounded source and account identities and an ISO date");
  }
  assertNonEmpty(sourceId, "sourceId");
  assertNonEmpty(accountId, "accountId");
  assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async client => {
    await resolveBook(client, scope);
    const result = await client.query(
      `select account."account_id", account."source_id", account."source_account_id",
  account."account_number", account."name", account."type", account."classification", account."active"
from "erp_financials"."accounts" account
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = account."tenant_id" and source."source_id" = account."source_id"
 and source."company_id" = $2 and source."book_id" = $3
 and (source."effective_from" is null or source."effective_from" <= $6::date)
 and (source."effective_through" is null or source."effective_through" >= $6::date)
where account."tenant_id" = $1 and account."source_id" = $4 and account."account_id" = $5
limit 1`, [scope.tenantId, scope.companyId, scope.bookId, sourceId, accountId, asOfDate]);
    const row = result.rows[0];
    if (row === undefined) throw new ErpFinancialsError("missing_account", "Account is not available in this reporting book", { details: { accountId, sourceId, bookId: scope.bookId } });
    const accountNumber = optionalString(row.account_number);
    return { accountId: string(row.account_id, "account_id"), sourceId: string(row.source_id, "source_id"),
      sourceAccountId: string(row.source_account_id, "source_account_id"), name: string(row.name, "name"),
      type: string(row.type, "type"), classification: string(row.classification, "classification") as AccountClassification,
      active: row.active === true, ...(accountNumber === undefined ? {} : { accountNumber }) };
  });
}

async function listChartOfAccounts(
  scope: Scope,
  input: { readonly asOfDate?: IsoDate; readonly includeInactive?: boolean }
): Promise<readonly ChartOfAccountsItem[]> {
  const asOfDate = input.asOfDate ?? today();
  assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `select coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id") as "book_account_key",
  array_agg(account."source_id" || ':' || account."account_id" order by account."source_id", account."account_id") as "source_account_ids",
  coalesce(min(book_account."account_number"), min(account."account_number")) as "account_number",
  coalesce(min(book_account."name"), min(account."name")) as "account_name",
  coalesce(min(book_account."classification"), min(account."classification")) as "classification",
  coalesce(min(book_account."account_type"), min(account."type")) as "account_type",
  coalesce(min(book_account."account_subtype"), min(account."subtype")) as "account_subtype",
  min(book_account."account_role") as "account_role", min(book_account."version") as "version",
  case when count(mapping."book_account_key") > 0
    then min(book_account."parent_book_account_key")
    else min(coalesce(parent_mapping."book_account_key",
      case when parent_account."account_id" is null then null
        else parent_account."source_id" || ':' || parent_account."account_id" end))
  end as "parent_book_account_key",
  coalesce(bool_or(book_account."active"), bool_or(account."active")) as "active",
  coalesce(sum(posting."debit_amount"), 0) as "debit_amount",
  coalesce(sum(posting."credit_amount"), 0) as "credit_amount", coalesce(sum(posting."net_amount"), 0) as "balance"
from "erp_financials"."accounts" account
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = account."source_id"
 and (source."effective_from" is null or source."effective_from" <= $4::date)
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = account."source_id" and mapping."account_id" = account."account_id"
left join "erp_financials"."reporting_book_accounts" book_account
  on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
 and book_account."book_account_key" = mapping."book_account_key"
left join "erp_financials"."accounts" parent_account
  on parent_account."tenant_id" = account."tenant_id" and parent_account."source_id" = account."source_id"
 and parent_account."account_id" = account."parent_account_id"
left join "erp_financials"."reporting_book_account_mappings" parent_mapping
  on parent_mapping."tenant_id" = $1 and parent_mapping."company_id" = $2 and parent_mapping."book_id" = $3
 and parent_mapping."source_id" = parent_account."source_id" and parent_mapping."account_id" = parent_account."account_id"
left join "erp_financials"."ledger_postings" posting
  on posting."tenant_id" = account."tenant_id" and posting."source_id" = account."source_id" and posting."account_id" = account."account_id"
 and posting."accounting_basis" = $5 and posting."currency_code" = $6 and posting."posting_date" <= $4::date
 and (source."effective_from" is null or source."effective_from" <= posting."posting_date")
 and (source."effective_through" is null or source."effective_through" >= posting."posting_date")
where account."tenant_id" = $1
group by coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id")
order by min(account."account_number") nulls last, min(account."name"), "book_account_key"`,
      [scope.tenantId, scope.companyId, scope.bookId, asOfDate, book.accountingBasis, book.currencyCode]
    );
    const defined = await client.query(
      `select "book_account_key", "account_number", "name" as "account_name", "classification",
  "account_type", "account_subtype", "account_role", "version", "parent_book_account_key", "active"
from "erp_financials"."reporting_book_accounts"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3
order by "account_number" nulls last, "name", "book_account_key"`,
      [scope.tenantId, scope.companyId, scope.bookId]
    );
    return visibleChartAccounts(rollupChartAccounts(mergeBookChartAccounts(
      result.rows.map((row) => chartAccountFromRow(row, book.currencyCode)),
      defined.rows,
      book.currencyCode
    )), input.includeInactive === true);
  });
}

// Shared effective-date AR reconstruction. SQL expressions are internal constants,
// never caller-provided values; reporting inputs remain bound parameters.
function receivableAgingDocumentsSql(asOf = "$6", currency = "$5", documentType = "$4", offsetTypes = "$7", party?: string): string {
  return `with effective_applications as materialized (
  select application."source_id",application."target_document_id",application."source_document_id",
    application."application_type",application."applied_amount"
  from "erp_financials"."subledger_applications" application
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id" = application."tenant_id" and source."company_id" = application."company_id"
   and source."source_id" = application."source_id" and source."book_id" = $3
  join "erp_financials"."financial_lifecycle_events" applied_event
    on applied_event."tenant_id" = application."tenant_id" and applied_event."company_id" = application."company_id"
   and applied_event."source_id" = application."source_id" and applied_event."event_id" = application."applied_event_id"
  left join "erp_financials"."financial_lifecycle_events" ended_event
    on ended_event."tenant_id" = application."tenant_id" and ended_event."company_id" = application."company_id"
   and ended_event."source_id" = application."source_id" and ended_event."event_id" = application."ended_event_id"
  where application."tenant_id" = $1 and application."company_id" = $2 and application."currency_code" = ${currency}
    ${party === undefined ? "" : `and exists(select 1 from erp_financials.subledger_documents customer_document
      where customer_document.tenant_id=application.tenant_id and customer_document.company_id=application.company_id
        and customer_document.source_id=application.source_id and customer_document.subledger_document_id=application.source_document_id
        and customer_document.party_id=${party})`}
    and application."application_type" in ('customer_payment_to_invoice','credit_to_invoice','write_off_to_invoice','customer_payment_to_refund')
    and application."application_date" <= ${asOf}::date
    and coalesce((applied_event."payload"->>'applicationDate')::date, (applied_event."occurred_at" at time zone 'UTC')::date) <= ${asOf}::date
    and (ended_event."event_id" is null or coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) > ${asOf}::date)
), applied_documents as (
  select source_id, document_id, document_type, sum(applied_amount) amount from (
    select source_id,target_document_id document_id,'invoice'::text document_type,applied_amount
    from effective_applications where application_type in ('customer_payment_to_invoice','credit_to_invoice','write_off_to_invoice')
    union all
    select source_id,source_document_id,
      case when application_type='credit_to_invoice' then 'credit_memo' else 'customer_payment' end,applied_amount
    from effective_applications where application_type in ('customer_payment_to_invoice','credit_to_invoice','customer_payment_to_refund')
  ) sides group by source_id,document_id,document_type
), terminal_documents as (
  select link."source_id",link."original_transaction_id",min(related."transaction_date") "effective_date"
  from "erp_financials"."journal_entry_links" link
  join "erp_financials"."transactions" related on related."tenant_id" = link."tenant_id"
   and related."source_id" = link."source_id" and related."transaction_id" = link."related_transaction_id"
  where link."tenant_id" = $1 and link."company_id" = $2 and link."link_type" in ('void','reversal')
  ${party === undefined ? "" : `and exists(select 1 from erp_financials.subledger_documents customer_document
    where customer_document.tenant_id=link.tenant_id and customer_document.company_id=link.company_id
      and customer_document.source_id=link.source_id and customer_document.transaction_id=link.original_transaction_id
      and customer_document.party_id=${party})`}
  group by link."source_id",link."original_transaction_id"
), aging_balances as (
select document."party_id", party."display_name" as "party_name", document."document_type", document."due_date",
  case when document."document_type" = ${documentType} then coalesce(document."due_date", document."document_date") else document."document_date" end as "aging_date",
  case
    when terminal."effective_date" <= ${asOf}::date then 0
    -- Preserve provider-owned current snapshots where the provider does not
    -- supply a complete application history (same contract as the AP register).
    when document."metadata"->>'provider' = 'quickbooks' and document."updated_at" < (${asOf}::date + interval '1 day') then document."open_amount"
    else greatest(document."original_amount" - coalesce(applied."amount", 0), 0)
  end as "historical_open_amount"
from "erp_financials"."subledger_documents" document
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = document."tenant_id" and source."company_id" = document."company_id"
 and source."book_id" = $3 and source."source_id" = document."source_id"
 and (source."effective_from" is null or source."effective_from" <= coalesce(document."recognition_date",document."document_date"))
 and (source."effective_through" is null or source."effective_through" >= coalesce(document."recognition_date",document."document_date"))
left join "erp_financials"."parties" party
  on party."tenant_id" = document."tenant_id" and party."source_id" = document."source_id" and party."party_id" = document."party_id"
left join applied_documents applied on applied.source_id=document."source_id"
 and applied.document_id=document."subledger_document_id" and applied.document_type=document."document_type"
left join terminal_documents terminal on document."document_type" <> 'invoice'
 and terminal."source_id"=document."source_id" and terminal."original_transaction_id"=document."transaction_id"
where document."tenant_id" = $1 and document."company_id" = $2
  ${party === undefined ? "" : `and document.party_id=${party}`}
  and (document."document_type" = ${documentType} or document."document_type" = any(${offsetTypes}::text[]))
  and document."currency_code" = ${currency} and coalesce(document."recognition_date",document."document_date") <= ${asOf}::date
), aging_documents as (
  select "party_id", "party_name", "document_type", "aging_date", "due_date",
    case when "document_type" = ${documentType} then "historical_open_amount" else -"historical_open_amount" end as "signed_open_amount"
  from aging_balances where "historical_open_amount" > 0
)`;
}

/** One result row; no journal-history scan or application document collection.
 * Reuse the same historical subledger rules as aging/dashboard accounting. */
async function getOutstandingDocumentSummary(scope: Scope, request: { readonly asOfDate: IsoDate }): Promise<OutstandingDocumentSummary> {
  const asOfDate = request.asOfDate; assertDate(asOfDate, "asOfDate");
  return scope.database.transaction(async client => {
    const result = await client.query(`/* outstanding_document_summary */
with book as (select base_currency_code,status from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3)
select book.*,statement_timestamp() observed_at,ar.*,ap.* from book
cross join lateral (
  ${receivableAgingDocumentsSql("$4", "book.base_currency_code", "'invoice'", "'{}'::text[]")}
  select count(*)::text invoice_count,count(*) filter(where due_date<$4::date)::text overdue_invoice_count
  from aging_documents where book.status='active' and signed_open_amount>0
) ar
cross join lateral (
  ${vendorBillRowsSql(5, "book.base_currency_code", "null::text", "null::text")}
  select count(*)::text bill_count,count(*) filter(where due_date<$4::date)::text overdue_bill_count
  from bill_rows where book.status='active' and open_amount>0
) ap`, [scope.tenantId,scope.companyId,scope.bookId,asOfDate]);
    const row=result.rows[0];
    if(!row) throw new ErpFinancialsError("missing_book", "Reporting book does not exist");
    if(row.status!=="active") throw new ErpFinancialsError("terminal_state_conflict", "Reporting book is not active");
    const count=(key:string)=>{const value=string(row[key],key);if(!/^(0|[1-9]\d*)$/.test(value))throw new Error("Invalid outstanding document count");return value;};
    return {tenantId:scope.tenantId,companyId:scope.companyId,bookId:scope.bookId,asOfDate,observedAt:isoDateTime(row.observed_at,"observed_at"),
      currencyCode:string(row.base_currency_code,"base_currency_code"),outstandingInvoiceCount:count("invoice_count"),overdueInvoiceCount:count("overdue_invoice_count"),
      outstandingVendorBillCount:count("bill_count"),overdueVendorBillCount:count("overdue_bill_count")};
  });
}

async function getDashboardSummary(
  scope: Scope,
  request: { readonly periodStart: IsoDate; readonly asOfDate: IsoDate; readonly accountingMethod?: ReportAccountingMethod }
): Promise<FinancialDashboardSummary> {
  const input = { periodStart: request.periodStart, asOfDate: request.asOfDate, accountingMethod: request.accountingMethod };
  assertWindow(input.periodStart, input.asOfDate);
  assertReportAccountingMethod(input.accountingMethod);
  return scope.database.transaction(async (client) => {
    const result = await client.query(`/* financial_dashboard_snapshot */
with book as (
  select "base_currency_code", "accounting_basis", "status" from "erp_financials"."reporting_books"
  where "tenant_id"=$1 and "company_id"=$2 and "book_id"=$3
), scoped_postings as (
  select coalesce(book_account."classification", account."classification") as "classification", posting."net_amount", posting."posting_date"
  from book
  join "erp_financials"."ledger_postings" posting on posting."tenant_id"=$1
   and posting."accounting_basis"=coalesce($6::text,book.accounting_basis) and posting."currency_code"=book.base_currency_code
   and posting."posting_date" <= $4::date
  join "erp_financials"."accounts" account
    on account."tenant_id"=posting."tenant_id" and account."source_id"=posting."source_id" and account."account_id"=posting."account_id"
  join "erp_financials"."reporting_book_sources" source
    on source."tenant_id"=$1 and source."company_id"=$2 and source."book_id"=$3 and source."source_id"=posting."source_id"
   and (source."effective_from" is null or source."effective_from"<=posting."posting_date")
   and (source."effective_through" is null or source."effective_through">=posting."posting_date")
  left join "erp_financials"."reporting_book_account_mappings" mapping
    on mapping."tenant_id"=$1 and mapping."company_id"=$2 and mapping."book_id"=$3
   and mapping."source_id"=account."source_id" and mapping."account_id"=account."account_id"
  left join "erp_financials"."reporting_book_accounts" book_account
    on book_account."tenant_id"=$1 and book_account."company_id"=$2 and book_account."book_id"=$3
   and book_account."book_account_key"=mapping."book_account_key"
  where book.status='active'
)
select book.*, ledger.*, ar.*, ap.* from book
cross join lateral (
  select
    coalesce(sum("net_amount") filter (where "classification"='asset'),0) as assets,
    coalesce(-sum("net_amount") filter (where "classification"='liability'),0) as liabilities,
    -- Direct equity plus all effective retained/current earnings, as in the balance sheet.
    coalesce(-sum("net_amount") filter (where "classification" in ('equity','income','other_income','expense','cost_of_goods_sold','other_expense')),0) as equity,
    coalesce(-sum("net_amount") filter (where "classification" in ('income','other_income') and "posting_date">=$5::date),0) as revenue,
    coalesce(sum("net_amount") filter (where "classification" in ('expense','cost_of_goods_sold','other_expense') and "posting_date">=$5::date),0) as expenses
  from scoped_postings
) ledger
cross join lateral (
  ${receivableAgingDocumentsSql("$4", "book.base_currency_code", "'invoice'", "'{}'::text[]")}
  select coalesce(sum(signed_open_amount),0) as receivables,
    coalesce(sum(signed_open_amount) filter(where due_date<$4::date),0) as overdue_receivables
  from aging_documents where book.status='active'
) ar
cross join lateral (
  ${vendorBillRowsSql(7, "book.base_currency_code", "null::text", "null::text")}
  select coalesce(sum(open_amount),0) as payables,
    coalesce(sum(open_amount) filter(where due_date<$4::date),0) as overdue_payables
  from bill_rows where book.status='active'
) ap`, [scope.tenantId, scope.companyId, scope.bookId, input.asOfDate, input.periodStart, input.accountingMethod ?? null]);
    const row = result.rows[0];
    if (!row) throw new ErpFinancialsError("missing_book", `Reporting book ${scope.bookId} does not exist`, { details: { bookId: scope.bookId } });
    if (row.status !== "active") throw new ErpFinancialsError("terminal_state_conflict", `Reporting book ${scope.bookId} is not active`, { details: { bookId: scope.bookId } });
    const revenue = money(row.revenue, "revenue"), expenses = money(row.expenses, "expenses");
    return {
      asOfDate: input.asOfDate, periodStart: input.periodStart,
      accountingBasis: input.accountingMethod ?? string(row.accounting_basis,"accounting_basis") as AccountingBasis,
      currencyCode: string(row.base_currency_code,"base_currency_code"),
      assets: money(row.assets,"assets"), liabilities: money(row.liabilities,"liabilities"), equity: money(row.equity,"equity"),
      revenue, expenses, netIncome: subtractMoney(revenue,expenses),
      accountsReceivable: money(row.receivables,"receivables"), accountsPayable: money(row.payables,"payables"),
      overdueReceivables: money(row.overdue_receivables,"overdue_receivables"), overduePayables: money(row.overdue_payables,"overdue_payables")
    };
  });
}

async function getFinancialStatement(scope: Scope, input: FinancialStatementRequest): Promise<FinancialStatement> {
  const statements = await getFinancialStatements(scope, { statements: [input] });
  const statement = statements[0];
  if (!statement) throw new ErpFinancialsError("invalid_input", "Financial statement is missing");
  return statement;
}

/** Configuration and all requested statement amounts share one PostgreSQL SQL
 * snapshot, including derived earnings. Works inside existing host transactions
 * without changing their isolation level or taking accounting writer locks. */
async function getFinancialStatements(scope: Scope, request: FinancialStatementsRequest): Promise<readonly FinancialStatement[]> {
  if (!Array.isArray(request.statements) || request.statements.length < 1 || request.statements.length > 36) {
    throw new ErpFinancialsError("invalid_input", "Request between one and 36 financial statement windows");
  }
  const inputs = request.statements.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new ErpFinancialsError("invalid_input", "Invalid financial statement window");
    const value = raw as FinancialStatementRequest;
    const input: FinancialStatementRequest = { reportName: value.reportName, periodStart: value.periodStart, periodEnd: value.periodEnd,
      ...(value.asOfDate === undefined ? {} : { asOfDate: value.asOfDate }),
      ...(value.accountingMethod === undefined ? {} : { accountingMethod: value.accountingMethod }) };
    assertWindow(input.periodStart, input.periodEnd); assertReportAccountingMethod(input.accountingMethod);
    assertDate(input.asOfDate ?? input.periodEnd, "asOfDate");
    if (!["profit_and_loss", "balance_sheet", "trial_balance"].includes(input.reportName)) throw new ErpFinancialsError("invalid_input", "Unsupported financial statement");
    return input;
  });
  const windows = inputs.map((input, ordinal) => ({ ordinal, report_name: input.reportName, period_start: input.periodStart,
    period_end: input.periodEnd, as_of_date: input.asOfDate ?? input.periodEnd, accounting_method: input.accountingMethod ?? null }));
  // Bound parameters let PostgreSQL use date-distribution statistics instead of
  // guessing scalar-subquery bounds and sorting a much larger history than estimated.
  const minimumPostingDate = inputs.some(input => input.reportName !== "profit_and_loss") ? "-infinity"
    : inputs.map(input => input.periodStart).reduce((first, next) => first < next ? first : next);
  const maximumPostingDate = inputs.map(input => input.reportName === "profit_and_loss" ? input.periodEnd : input.asOfDate ?? input.periodEnd)
    .reduce((last, next) => last > next ? last : next);
  return scope.database.transaction(async client => {
    const response = await client.query(`/* financial_statement_snapshot */
with requested as (
  select * from jsonb_to_recordset($4::jsonb) as item(ordinal integer, report_name text,
    period_start date, period_end date, as_of_date date, accounting_method text)
  -- The validated array has exactly this many rows. Expose that cardinality to
  -- the planner instead of jsonb_to_recordset's fixed 100-row estimate, which
  -- multiplies every correlated statement and can trigger expensive JIT plans.
  limit ${String(inputs.length)}
), book as (
  select "base_currency_code", "accounting_basis", "status" from "erp_financials"."reporting_books"
  where "tenant_id"=$1 and "company_id"=$2 and "book_id"=$3
), boundaries as (
  -- Every requested inclusive window can be reconstructed from these disjoint
  -- date bands. This reduces ledger history once, without rounding to months or
  -- losing arbitrary day boundaries, cash/accrual identity, or numeric precision.
  select array(select distinct boundary from (
    select period_start boundary from requested
    union all select period_end + 1 from requested
    union all select as_of_date + 1 from requested
  ) dates order by boundary) dates
), statement_postings as materialized (
  select posting."tenant_id", posting."source_id", posting."account_id", posting."accounting_basis", posting."currency_code",
    min(posting."posting_date") as "posting_date",
    sum(posting."debit_amount") as "debit_amount", sum(posting."credit_amount") as "credit_amount", sum(posting."net_amount") as "net_amount"
  from book cross join boundaries
  join "erp_financials"."ledger_postings" posting on posting."tenant_id"=$1 and posting."currency_code"=book.base_currency_code
   and posting."posting_date" <= $6::date
   and posting."posting_date" >= $5::date
  join "erp_financials"."reporting_book_sources" source on source."tenant_id"=$1 and source."company_id"=$2 and source."book_id"=$3
   and source."source_id"=posting."source_id"
   and (source."effective_from" is null or source."effective_from"<=posting."posting_date")
   and (source."effective_through" is null or source."effective_through">=posting."posting_date")
  where book.status='active'
    and exists(select 1 from requested where posting."accounting_basis"=coalesce(accounting_method,book.accounting_basis))
  group by posting."tenant_id", posting."source_id", posting."account_id", posting."accounting_basis", posting."currency_code",
    width_bucket(posting."posting_date",boundaries.dates)
)
select requested.ordinal, book.base_currency_code, book.accounting_basis, book.status,
  case when book.status='active' then (select coalesce(jsonb_agg(to_jsonb(statement_rows)),'[]'::jsonb) from (
select coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id") as "book_account_key",
  case when count(mapping."book_account_key") > 0
    then min(book_account."parent_book_account_key")
    else min(coalesce(parent_mapping."book_account_key",
      case when parent_account."account_id" is null then null
        else parent_account."source_id" || ':' || parent_account."account_id" end))
  end as "parent_book_account_key",
  coalesce(min(book_account."account_number"), min(account."account_number")) as "account_number",
  coalesce(min(book_account."name"), min(account."name")) as "account_name",
  coalesce(min(book_account."classification"), min(account."classification")) as "classification",
  bool_or(regexp_replace(lower(coalesce(book_account."account_subtype", account."subtype", '')),
    '[^a-z0-9]', '', 'g') = 'retainedearnings'
    and (source."effective_from" is null or source."effective_from" <= requested.as_of_date::date)) as "is_retained_earnings",
  coalesce(sum(posting."debit_amount"), 0)::text as "debit_amount",
  coalesce(sum(posting."credit_amount"), 0)::text as "credit_amount",
  coalesce(sum(posting."net_amount"), 0)::text as "net_amount"
from "erp_financials"."accounts" account
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = account."source_id"
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = account."source_id" and mapping."account_id" = account."account_id"
left join "erp_financials"."reporting_book_accounts" book_account
  on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
 and book_account."book_account_key" = mapping."book_account_key"
left join "erp_financials"."accounts" parent_account
  on parent_account."tenant_id" = account."tenant_id" and parent_account."source_id" = account."source_id"
 and parent_account."account_id" = account."parent_account_id"
left join "erp_financials"."reporting_book_account_mappings" parent_mapping
  on parent_mapping."tenant_id" = $1 and parent_mapping."company_id" = $2 and parent_mapping."book_id" = $3
 and parent_mapping."source_id" = parent_account."source_id" and parent_mapping."account_id" = parent_account."account_id"
left join statement_postings posting
  on posting."tenant_id" = account."tenant_id" and posting."source_id" = account."source_id" and posting."account_id" = account."account_id"
 and posting."accounting_basis" = coalesce(requested.accounting_method,book.accounting_basis) and posting."currency_code" = book.base_currency_code
 and posting."posting_date" >= case when requested.report_name = 'profit_and_loss' then requested.period_start else '-infinity'::date end
 and posting."posting_date" <= case when requested.report_name = 'profit_and_loss' then requested.period_end else requested.as_of_date end
 and (source."effective_from" is null or source."effective_from" <= posting."posting_date")
 and (source."effective_through" is null or source."effective_through" >= posting."posting_date")
where account."tenant_id" = $1
  and ((requested.report_name = 'profit_and_loss' and coalesce(book_account."classification", account."classification") in ('income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense'))
    or (requested.report_name = 'balance_sheet' and coalesce(book_account."classification", account."classification") in ('asset', 'liability', 'equity'))
    or requested.report_name = 'trial_balance')
group by coalesce(mapping."book_account_key", account."source_id" || ':' || account."account_id")
order by coalesce(min(book_account."account_number"), min(account."account_number")) nulls last,
  coalesce(min(book_account."name"), min(account."name")), "book_account_key"
  ) statement_rows) else '[]'::jsonb end statement_lines,
  case when book.status='active' then (select coalesce(jsonb_agg(to_jsonb(defined_rows)),'[]'::jsonb) from (
select "book_account_key", "parent_book_account_key", "account_number", "name" as "account_name", "classification", "account_subtype"
from "erp_financials"."reporting_book_accounts"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3
  and ((requested.report_name = 'profit_and_loss' and "classification" in ('income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense'))
    or (requested.report_name = 'balance_sheet' and "classification" in ('asset', 'liability', 'equity'))
    or requested.report_name = 'trial_balance')
order by "account_number" nulls last, "name", "book_account_key"
  ) defined_rows) else '[]'::jsonb end defined_lines,
  case when book.status='active' and requested.report_name='balance_sheet' then (select to_jsonb(earnings_row) from (
select
  coalesce(-sum(posting."net_amount") filter (where posting."posting_date" < requested.period_start::date), 0)::text as "retained_earnings",
  coalesce(-sum(posting."net_amount") filter (where posting."posting_date" between requested.period_start::date and requested.as_of_date::date), 0)::text as "net_income"
from "erp_financials"."accounts" account
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = account."source_id"
left join "erp_financials"."reporting_book_account_mappings" mapping
  on mapping."tenant_id" = $1 and mapping."company_id" = $2 and mapping."book_id" = $3
 and mapping."source_id" = account."source_id" and mapping."account_id" = account."account_id"
left join "erp_financials"."reporting_book_accounts" book_account
  on book_account."tenant_id" = $1 and book_account."company_id" = $2 and book_account."book_id" = $3
 and book_account."book_account_key" = mapping."book_account_key"
join statement_postings posting
  on posting."tenant_id" = account."tenant_id" and posting."source_id" = account."source_id" and posting."account_id" = account."account_id"
 and posting."accounting_basis" = coalesce(requested.accounting_method,book.accounting_basis) and posting."currency_code" = book.base_currency_code
 and posting."posting_date" <= requested.as_of_date::date
 and (source."effective_from" is null or source."effective_from" <= posting."posting_date")
 and (source."effective_through" is null or source."effective_through" >= posting."posting_date")
where account."tenant_id" = $1
  and coalesce(book_account."classification", account."classification") in
    ('income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense')
  ) earnings_row) else null end earnings
from requested cross join book order by requested.ordinal`, [scope.tenantId, scope.companyId, scope.bookId, JSON.stringify(windows), minimumPostingDate, maximumPostingDate]);
    if (!response.rows.length) throw new ErpFinancialsError("missing_book", `Reporting book ${scope.bookId} does not exist`, { details: { bookId: scope.bookId } });
    if (response.rows.length !== inputs.length) throw new ErpFinancialsError("invalid_input", "Financial statement window count does not match");
    return response.rows.map((snapshot, ordinal) => {
      if (snapshot.status !== "active") throw new ErpFinancialsError("terminal_state_conflict", `Reporting book ${scope.bookId} is not active`, { details: { bookId: scope.bookId } });
      const input = inputs[ordinal];
      if (!input || snapshot.ordinal !== ordinal) throw new ErpFinancialsError("invalid_input", "Financial statement window order does not match");
      const book = { currencyCode: string(snapshot.base_currency_code, "base_currency_code"), accountingBasis: string(snapshot.accounting_basis, "accounting_basis") as AccountingBasis };
      const accountingBasis = input.accountingMethod ?? book.accountingBasis, asOfDate = input.asOfDate ?? input.periodEnd;
      const rows = (value: unknown): Record<string, unknown>[] => {
        if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new ErpFinancialsError("invalid_input", "Invalid statement rows");
        return value as Record<string, unknown>[];
      };
      const result = { rows: rows(snapshot.statement_lines) }, defined = { rows: rows(snapshot.defined_lines) };
    const direct = [...mergeBookStatementLines(result.rows.map(statementLineFromRow), defined.rows)];
    if (input.reportName === "balance_sheet") {
      // Resolve reporting identities, never display labels. Multiple source accounts
      // mapped to the same key count once; distinct candidates remain ambiguous.
      const retainedKeys = new Set([...result.rows, ...defined.rows]
        .filter((row) => row.classification === "equity" && (row.is_retained_earnings === true ||
          optionalString(row.account_subtype)?.toLowerCase().replace(/[^a-z0-9]/gu, "") === "retainedearnings"))
        .map((row) => string(row.book_account_key, "book_account_key")));
      const retainedKey = retainedKeys.size === 1 ? [...retainedKeys][0] : undefined;
      const earnings = requiredRow(snapshot.earnings as Record<string, unknown> | undefined, "balance sheet earnings");
      for (const [key, name, value] of [
        ["retained_earnings", "Retained Earnings", earnings.retained_earnings],
        ["net_income", "Net Income", earnings.net_income]
      ] as const) {
        const amount = money(value, key);
        if (moneyMinor(amount) !== 0n) {
          const derived = derivedEquityStatementLine(key, name, amount);
          const index = key === "retained_earnings" && retainedKey !== undefined
            ? direct.findIndex((line) => line.bookAccountKey === retainedKey)
            : -1;
          const existing = direct[index];
          if (existing === undefined) {
            direct.push(derived);
          } else {
            direct[index] = {
              ...existing,
              directAmount: addMoney(existing.directAmount, amount),
              amount: addMoney(existing.amount, amount),
              debitAmount: addMoney(existing.debitAmount, derived.debitAmount),
              creditAmount: addMoney(existing.creditAmount, derived.creditAmount),
              derivedAmount: amount
            };
          }
        }
      }
    }
    const lines = rollupStatementLines(direct).map((line): FinancialStatementLine => ({
      ...line,
      ...(line.derivedAmount !== undefined
        ? {}
        : {
            drilldown: {
              periodStart: input.reportName === "profit_and_loss" ? input.periodStart : "0001-01-01",
              periodEnd: input.reportName === "profit_and_loss" ? input.periodEnd : asOfDate,
              ...(accountingBasis === "cash" || accountingBasis === "accrual"
                ? { accountingMethod: accountingBasis }
                : {}),
              accountKey: line.bookAccountKey
            }
          })
    }));
    return {
      reportName: input.reportName,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      asOfDate,
      accountingBasis,
      currencyCode: book.currencyCode,
      lines,
      totals: statementTotals(input.reportName, lines)
    };
    });
  });
}

async function getAging(scope: Scope, input: AgingPageRequest): Promise<AgingReport>;
async function getAging(scope: Scope, input: AgingPageRequest, paginate: true): Promise<AgingPage>;
async function getAging(scope: Scope, input: AgingPageRequest, paginate = false): Promise<AgingReport | AgingPage> {
  input = structuredClone(input);
  assertDate(input.asOfDate, "asOfDate");
  if (!["receivables", "payables"].includes(input.kind)) throw new ErpFinancialsError("invalid_input", "Unsupported aging kind");
  const limit = input.limit ?? 50;
  const cursorScope = createHash("sha256").update(JSON.stringify(["aging-page-v1",scope.tenantId,scope.companyId,scope.bookId,input.kind,input.asOfDate])).digest("hex");
  let afterParty: string | null = null, expectedRevision: string | undefined;
  if (paginate) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ErpFinancialsError("invalid_input", "Aging page limit must be between 1 and 200");
    if (input.cursor !== undefined) {
      let cursor: unknown;
      try {
        if (typeof input.cursor !== "string" || input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw Error("Invalid cursor");
        cursor = JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));
      } catch { throw new ErpFinancialsError("invalid_input", "Aging page cursor is invalid"); }
      if (!isRecord(cursor) || cursor.v !== 1 || cursor.scope !== cursorScope || typeof cursor.partyId !== "string" || !cursor.partyId
        || typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.revision)) throw new ErpFinancialsError("invalid_input", "Aging page cursor does not match its scope");
      afterParty = cursor.partyId; expectedRevision = cursor.revision;
    }
  }
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const documentType = input.kind === "receivables" ? "invoice" : "vendor_bill";
    const offsetDocumentTypes = input.kind === "receivables" ? ["customer_payment", "credit_memo"] : [];
    // Reconstruct effective balances, not current open_amount, for as-of reports.
    // AR preserves its net-of-unapplied-receipts/credits contract; AP is gross.
    // Aggregate effective application sides once for the report. Per-document
    // lateral event reconstruction repeats indexed work and can cause costly
    // JIT compilation even for a 50-row page with whole-report controls.
    const agingDocuments = input.kind === "payables"
      ? `${vendorBillRowsSql(7)}, aging_documents as (
select "party_id", "party_name", "due_date" as "aging_date", "open_amount" as "signed_open_amount"
from bill_rows where "open_amount" > 0
)`
      : receivableAgingDocumentsSql();
    const asOf = input.kind === "payables" ? "$4" : "$6";
    const parameters = input.kind === "payables"
      ? [scope.tenantId, scope.companyId, scope.bookId, input.asOfDate, book.currencyCode, null, null]
      : [scope.tenantId, scope.companyId, scope.bookId, documentType, book.currencyCode, input.asOfDate, offsetDocumentTypes];
    const groupedSql = `select "party_id", "party_name",
  coalesce(sum("signed_open_amount") filter (where "aging_date" >= ${asOf}::date), 0) as "current_amount",
  coalesce(sum("signed_open_amount") filter (where ${asOf}::date - "aging_date" between 1 and 30), 0) as "days_1_30",
  coalesce(sum("signed_open_amount") filter (where ${asOf}::date - "aging_date" between 31 and 60), 0) as "days_31_60",
  coalesce(sum("signed_open_amount") filter (where ${asOf}::date - "aging_date" between 61 and 90), 0) as "days_61_90",
  coalesce(sum("signed_open_amount") filter (where ${asOf}::date - "aging_date" > 90), 0) as "days_over_90",
  sum("signed_open_amount") as "total_amount"
from aging_documents
group by "party_id", "party_name"
having sum("signed_open_amount") <> 0`;
    if (paginate) {
      const result = await client.query(`${agingDocuments}, aging_rows as materialized (${groupedSql}),
 aging_summary as (
  select count(*)::text party_count,coalesce(sum(current_amount),0)::text summary_current,
    coalesce(sum(days_1_30),0)::text summary_days_1_30,coalesce(sum(days_31_60),0)::text summary_days_31_60,
    coalesce(sum(days_61_90),0)::text summary_days_61_90,coalesce(sum(days_over_90),0)::text summary_days_over_90,
    coalesce(sum(total_amount),0)::text summary_total from aging_rows
 ), scope_revision as (
  select encode(sha256(convert_to(jsonb_build_array(
    (select to_jsonb(b) from erp_financials.reporting_books b where b.tenant_id=$1 and b.company_id=$2 and b.book_id=$3),
    (select jsonb_agg(to_jsonb(bs) order by bs.source_id) from erp_financials.reporting_book_sources bs where bs.tenant_id=$1 and bs.company_id=$2 and bs.book_id=$3),
    (select coalesce(sum(r.revision),0)::text from erp_financials.accounting_source_revisions r
      join erp_financials.reporting_book_sources bs on bs.tenant_id=r.tenant_id and bs.source_id=r.source_id and bs.company_id=$2 and bs.book_id=$3 where r.tenant_id=$1)
  )::text,'UTF8')),'hex') revision
 ), aging_page as (
  select * from aging_rows where ($8::text is null or party_id>$8::text) order by party_id limit $9
 ) select s.*,r.revision,p.*,
  (select jsonb_build_object('currency',base_currency_code,'basis',accounting_basis,'status',status)
   from erp_financials.reporting_books where tenant_id=$1 and company_id=$2 and book_id=$3) current_book
 from aging_summary s cross join scope_revision r left join aging_page p on true order by p.party_id`,[...parameters,afterParty,limit+1]);
      const head=requiredRow(result.rows[0],"aging summary"),currentBook=head.current_book;
      if (!isRecord(currentBook) || currentBook.status!=="active" || currentBook.currency!==book.currencyCode || currentBook.basis!==book.accountingBasis) throw new ErpFinancialsError("optimistic_concurrency_conflict","Reporting book changed during aging read; reload");
      const revision=string(head.revision,"revision");
      if (expectedRevision!==undefined && expectedRevision!==revision) throw new ErpFinancialsError("optimistic_concurrency_conflict","Aging changed; reload from the first page");
      const partyCount=string(head.party_count,"party_count");
      if (!/^(0|[1-9]\d*)$/u.test(partyCount)) throw new ErpFinancialsError("invalid_input","Invalid aging party count");
      const candidates=result.rows.filter(row=>row.party_id!==null),rows=candidates.slice(0,limit).map(agingRowFromRow),last=rows.at(-1);
      return {kind:input.kind,asOfDate:input.asOfDate,currencyCode:book.currencyCode,basis:"as_of",partyCount,revision,rows,
        totals:{current:money(head.summary_current,"summary_current"),days1To30:money(head.summary_days_1_30,"summary_days_1_30"),days31To60:money(head.summary_days_31_60,"summary_days_31_60"),days61To90:money(head.summary_days_61_90,"summary_days_61_90"),daysOver90:money(head.summary_days_over_90,"summary_days_over_90"),total:money(head.summary_total,"summary_total")},
        ...(candidates.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({v:1,scope:cursorScope,partyId:last.partyId,revision}),"utf8").toString("base64url")}:{})};
    }
    const result = await client.query(`${agingDocuments} ${groupedSql} order by "total_amount" desc, "party_id"`, parameters);
    const rows = result.rows.map(agingRowFromRow);
    return {
      kind: input.kind,
      asOfDate: input.asOfDate,
      currencyCode: book.currencyCode,
      rows,
      totals: rows.reduce(
        (total, row) => ({
          current: addMoney(total.current, row.current),
          days1To30: addMoney(total.days1To30, row.days1To30),
          days31To60: addMoney(total.days31To60, row.days31To60),
          days61To90: addMoney(total.days61To90, row.days61To90),
          daysOver90: addMoney(total.daysOver90, row.daysOver90),
          total: addMoney(total.total, row.total)
        }),
        { current: "0.00", days1To30: "0.00", days31To60: "0.00", days61To90: "0.00", daysOver90: "0.00", total: "0.00" }
      )
    };
  });
}

async function listBankReconciliation(
  scope: Scope,
  input: PageRequest & { readonly status?: BankReconciliationListItem["status"] }
): Promise<Page<BankReconciliationListItem>> {
  const page = pageInput(input, "bank-reconciliation", scope.bookId);
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `select line.*, line."posted_date"::text as "posted_date", match."bank_reconciliation_match_id", match."version" as "bank_reconciliation_match_version",
  match."transaction_id", match."method"
from "erp_financials"."bank_statement_lines" line
left join "erp_financials"."bank_reconciliation_matches" match
  on match."tenant_id" = line."tenant_id" and match."company_id" = line."company_id" and match."book_id" = line."book_id"
 and match."bank_statement_line_id" = line."bank_statement_line_id" and match."status" = 'matched'
where line."tenant_id" = $1 and line."company_id" = $2 and line."book_id" = $3 and line."currency_code" = $4
  and ($5::text is null or line."status" = $5)
  and ($6::date is null or (line."posted_date", line."bank_statement_line_id") < ($6::date, $7::text))
order by line."posted_date" desc, line."bank_statement_line_id" desc
limit $8`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode, input.status, page.date, page.id, page.limit + 1]
    );
    return toPage(result.rows.map(bankLineFromRow), page.limit, "bank-reconciliation", scope.bookId, (item) => ({
      date: item.postedDate,
      id: item.bankStatementLineId
    }));
  });
}

async function getBankReconciliationSummary(scope: Scope): Promise<BankReconciliationSummary> {
  return scope.database.transaction(async (client) => {
    const book = await resolveBook(client, scope);
    const result = await client.query(
      `select count(*) filter (where "status" = 'unmatched')::integer as "unmatched_count",
  count(*) filter (where "status" = 'matched')::integer as "matched_count",
  count(*) filter (where "status" = 'ignored')::integer as "ignored_count",
  coalesce(sum(abs("amount")) filter (where "status" = 'unmatched'), 0) as "unmatched_amount",
  coalesce(sum(abs("amount")) filter (where "status" = 'matched'), 0) as "matched_amount"
from "erp_financials"."bank_statement_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "currency_code" = $4`,
      [scope.tenantId, scope.companyId, scope.bookId, book.currencyCode]
    );
    const row = requiredRow(result.rows[0], "bank reconciliation summary");
    return {
      currencyCode: book.currencyCode,
      unmatchedCount: integer(row.unmatched_count, "unmatched_count"),
      matchedCount: integer(row.matched_count, "matched_count"),
      ignoredCount: integer(row.ignored_count, "ignored_count"),
      unmatchedAbsoluteAmount: money(row.unmatched_amount, "unmatched_amount"),
      matchedAbsoluteAmount: money(row.matched_amount, "matched_amount")
    };
  });
}

const JOURNAL_ENTRY_STATUSES: ReadonlySet<string> = new Set(["posted", "reversed", "voided", "corrected", "replaced"]);
const FISCAL_PERIOD_READ_STATUSES: ReadonlySet<string> = new Set(["open", "closing", "closed"]);

function journalEntryFilters(input: JournalEntryFilters): JournalEntryFilters {
  const sourceId = readFilterText(input.sourceId, "sourceId");
  const transactionType = readFilterText(input.transactionType, "transactionType");
  // Validate without trimming: source keys are exact identities, not search text.
  const sourceTransactionId = input.sourceTransactionId;
  if (sourceTransactionId !== undefined) {
    assertReadFilterText(sourceTransactionId, "sourceTransactionId");
    if (!sourceId || !transactionType) throw new ErpFinancialsError("invalid_input", "sourceTransactionId requires sourceId and transactionType");
  }
  const preparerRef = readFilterText(input.preparerRef, "preparerRef");
  const search = readFilterText(input.search, "search", 100);
  if (input.status !== undefined && !JOURNAL_ENTRY_STATUSES.has(input.status)) {
    throw new ErpFinancialsError("invalid_input", "status is not a canonical journal-entry status");
  }
  if ((input.periodStart === undefined) !== (input.periodEnd === undefined)) {
    throw new ErpFinancialsError("invalid_input", "periodStart and periodEnd must be supplied together");
  }
  if (input.periodStart !== undefined && input.periodEnd !== undefined) {
    assertWindow(input.periodStart, input.periodEnd);
  }
  return {
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceTransactionId === undefined ? {} : { sourceTransactionId }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.periodStart === undefined ? {} : { periodStart: input.periodStart }),
    ...(input.periodEnd === undefined ? {} : { periodEnd: input.periodEnd }),
    ...(transactionType === undefined ? {} : { transactionType }),
    ...(preparerRef === undefined ? {} : { preparerRef }),
    ...(search === undefined ? {} : { search })
  };
}

function fiscalPeriodFilters(
  input: { readonly sourceId: string; readonly status?: FiscalPeriodReadModel["status"]; readonly fiscalYear?: number }
): { readonly sourceId: string; readonly status?: FiscalPeriodReadModel["status"]; readonly fiscalYear?: number } {
  const sourceId = assertReadFilterText(input.sourceId, "sourceId");
  if (input.status !== undefined && !FISCAL_PERIOD_READ_STATUSES.has(input.status)) {
    throw new ErpFinancialsError("invalid_input", "status is not a canonical fiscal-period status");
  }
  if (input.fiscalYear !== undefined && (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1)) {
    throw new ErpFinancialsError("invalid_input", "fiscalYear must be a positive integer");
  }
  return {
    sourceId,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.fiscalYear === undefined ? {} : { fiscalYear: input.fiscalYear })
  };
}

function readFilterText(value: string | undefined, field: string, max = 300): string | undefined {
  return value === undefined ? undefined : assertReadFilterText(value, field, max);
}

function assertReadFilterText(value: string, field: string, max = 300): string {
  if (typeof value !== "string") throw new ErpFinancialsError("invalid_input", `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new ErpFinancialsError("invalid_input", `${field} must contain between 1 and ${String(max)} characters`);
  }
  return normalized;
}

function readFilterFingerprint(filters: object): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 20);
}

function journalOriginFromSourceRef(sourceRef: Record<string, unknown> | undefined): JournalEntryOrigin | undefined {
  const preview = sourceRef?.preview;
  if (!isRecord(preview)) return undefined;
  const origin = optionalRecord(preview.journalOrigin, "source_payload_ref.preview.journalOrigin");
  if (origin === undefined) return undefined;
  const module = string(origin.module, "origin.module");
  const reference = optionalString(origin.reference);
  return { module, ...(reference === undefined ? {} : { reference }) };
}

function journalEntryFromRow(row: Readonly<Record<string, unknown>>): JournalEntryListItem {
  const transactionNumber = optionalString(row.transaction_number);
  const memo = optionalString(row.memo);
  const sourcePayloadRef = row.source_payload_ref === null || row.source_payload_ref === undefined
    ? undefined
    : jsonObject(row.source_payload_ref, "source_payload_ref");
  const origin = journalOriginFromSourceRef(sourcePayloadRef);
  const status = string(row.canonical_status, "canonical_status");
  if (!JOURNAL_ENTRY_STATUSES.has(status)) throw new Error("Stored canonical journal-entry status is invalid");
  return {
    journalEntryId: string(row.journal_entry_id, "journal_entry_id"),
    originalTransactionId: string(row.original_transaction_id, "original_transaction_id"),
    sourceId: string(row.source_id, "source_id"),
    ...(transactionNumber === undefined ? {} : { transactionNumber }),
    transactionDate: date(row.transaction_date, "transaction_date"),
    postedAt: isoDateTime(row.posted_at, "posted_at"),
    ...(memo === undefined ? {} : { memo }),
    currencyCode: string(row.currency_code, "currency_code"),
    accountingBasis: string(row.accounting_basis, "accounting_basis") as AccountingBasis,
    status: status as JournalEntryStatus,
    totalDebit: money(row.total_debit, "total_debit"),
    totalCredit: money(row.total_credit, "total_credit"),
    lineCount: integer(row.line_count, "line_count"),
    version: integer(row.version, "version"),
    sourceProvenance: {
      sourceId: string(row.source_id, "source_id"),
      sourceRole: reportingBookSourceRole(row.source_role),
      sourceSystem: string(row.source_system, "source_system"),
      providerEnvironment: string(row.provider_environment, "provider_environment"),
      sourceTransactionId: string(row.source_transaction_id, "source_transaction_id"),
      sourceTransactionType: string(row.source_transaction_type, "source_transaction_type"),
      ...sourceRefFields(sourcePayloadRef),
      ...(origin === undefined ? {} : { origin })
    },
    preparerProvenance: accountingLifecycleFromRow(row, "preparer")
  };
}

function journalEntryLineFromRow(row: Readonly<Record<string, unknown>>): JournalEntryLineReadModel {
  const accountNumber = optionalString(row.account_number);
  const partyId = optionalString(row.party_id);
  const itemId = optionalString(row.item_id);
  const description = optionalString(row.description);
  const dimensionRefs = row.dimension_refs === null || row.dimension_refs === undefined
    ? []
    : (typeof row.dimension_refs === "string" ? JSON.parse(row.dimension_refs) : row.dimension_refs) as JsonValue;
  return {
    transactionLineId: string(row.transaction_line_id, "transaction_line_id"),
    postingId: string(row.posting_id, "posting_id"),
    sourcePostingId: string(row.source_posting_id, "source_posting_id"),
    lineNumber: integer(row.line_number, "line_number"),
    account: {
      accountId: string(row.account_id, "account_id"),
      sourceAccountId: string(row.source_account_id, "source_account_id"),
      bookAccountKey: string(row.book_account_key, "book_account_key"),
      ...(accountNumber === undefined ? {} : { accountNumber }),
      accountName: string(row.account_name, "account_name"),
      classification: string(row.classification, "classification") as AccountClassification
    },
    ...(partyId === undefined ? {} : { partyId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(description === undefined ? {} : { description }),
    debitAmount: money(row.debit_amount, "debit_amount"),
    creditAmount: money(row.credit_amount, "credit_amount"),
    netAmount: money(row.net_amount, "net_amount"),
    dimensionRefs
  };
}

function assertBalancedJournalDetail(
  item: JournalEntryListItem,
  lines: readonly JournalEntryLineReadModel[]
): void {
  const debit = lines.reduce((sum, line) => sum + moneyMinor(line.debitAmount), 0n);
  const credit = lines.reduce((sum, line) => sum + moneyMinor(line.creditAmount), 0n);
  if (lines.length !== item.lineCount || debit !== credit || debit !== moneyMinor(item.totalDebit) ||
    credit !== moneyMinor(item.totalCredit)) {
    throw new ErpFinancialsError("posting_unbalanced", `Stored journal entry ${item.journalEntryId} is not exactly balanced`, {
      details: { journalEntryId: item.journalEntryId }
    });
  }
}

function journalEntryLinkFromRow(row: Readonly<Record<string, unknown>>): JournalEntryLifecycleLinkReadModel {
  const linkType = string(row.link_type, "link_type");
  if (!new Set<string>(["reversal", "void", "correction", "replacement"]).has(linkType)) {
    throw new Error("Stored journal-entry link type is invalid");
  }
  return {
    journalEntryLinkId: string(row.journal_entry_link_id, "journal_entry_link_id"),
    linkType: linkType as JournalEntryLifecycleLinkReadModel["linkType"],
    originalTransactionId: string(row.original_transaction_id, "original_transaction_id"),
    relatedTransactionId: string(row.related_transaction_id, "related_transaction_id"),
    createdAt: isoDateTime(row.created_at, "created_at"),
    lifecycle: accountingLifecycleFromRow(row)
  };
}

function fiscalPeriodFromRow(row: Readonly<Record<string, unknown>>): FiscalPeriodReadModel {
  const status = string(row.status, "status");
  if (!FISCAL_PERIOD_READ_STATUSES.has(status)) throw new Error("Stored fiscal-period status is invalid");
  const closeLifecycle = optionalString(row.close_event_id_read) === undefined
    ? undefined
    : accountingLifecycleFromRow(row, "close");
  const reopenLifecycle = optionalString(row.reopen_event_id_read) === undefined
    ? undefined
    : accountingLifecycleFromRow(row, "reopen");
  const closePayload = closeLifecycle === undefined ? undefined : jsonObject(row.close_payload, "close_payload");
  const canonicalCloseCertificateId = closePayload ? optionalString(closePayload.canonicalCloseCertificateId) : undefined;
  const closeEvidence = closeLifecycle === undefined || canonicalCloseCertificateId !== undefined ? undefined : fiscalCloseEvidenceFromPayload(row.close_payload);
  return {
    fiscalPeriodId: string(row.fiscal_period_id, "fiscal_period_id"),
    sourceId: string(row.source_id, "source_id"),
    fiscalYear: integer(row.fiscal_year, "fiscal_year"),
    periodNumber: integer(row.period_number, "period_number"),
    periodStart: date(row.period_start, "period_start"),
    periodEnd: date(row.period_end, "period_end"),
    status: status as FiscalPeriodReadModel["status"],
    version: integer(row.version, "version"),
    createdAt: isoDateTime(row.created_at, "created_at"),
    updatedAt: isoDateTime(row.updated_at, "updated_at"),
    ...(closeEvidence === undefined ? {} : { closeEvidence }),
    ...(canonicalCloseCertificateId === undefined ? {} : { canonicalCloseCertificateId }),
    ...(closeLifecycle === undefined ? {} : { closeLifecycle }),
    ...(reopenLifecycle === undefined ? {} : { reopenLifecycle }),
    latestLifecycle: accountingLifecycleFromRow(row, "latest")
  };
}

function fiscalCloseEvidenceFromPayload(value: unknown): NonNullable<FiscalPeriodReadModel["closeEvidence"]> {
  const payload = jsonObject(value, "close_payload");
  if (!Array.isArray(payload.reconciliationRefs) || payload.reconciliationRefs.length === 0 ||
    payload.reconciliationRefs.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error("Stored fiscal close reconciliationRefs must be a non-empty string array");
  }
  return {
    trialBalanceSnapshotId: string(payload.trialBalanceSnapshotId, "trialBalanceSnapshotId"),
    reconciliationRefs: payload.reconciliationRefs as readonly string[],
    checklistRef: string(payload.checklistRef, "checklistRef"),
    postingMaxUpdatedAt: isoDateTime(payload.postingMaxUpdatedAt, "postingMaxUpdatedAt"),
    evidenceChecksum: string(payload.evidenceChecksum, "evidenceChecksum")
  };
}

function accountingLifecycleFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix?: "preparer" | "close" | "reopen" | "latest"
): AccountingLifecycleProvenance {
  const field = (name: string): string => prefix === undefined ? name : `${prefix}_${name}`;
  const approverRef = optionalString(row[field("approver_ref")]);
  const reasonDetail = optionalString(row[field("reason_detail")]);
  const priorEventId = optionalString(row[field("prior_event_id")]);
  return {
    lifecycleEventId: string(row[field("event_id")], field("event_id")),
    eventType: string(row[field("event_type")], field("event_type")),
    actorRef: string(row[field("actor_ref")], field("actor_ref")),
    ...(approverRef === undefined ? {} : { approverRef }),
    requestId: string(row[field("request_id")], field("request_id")),
    correlationId: string(row[field("correlation_id")], field("correlation_id")),
    reasonCode: string(row[field("reason_code")], field("reason_code")),
    ...(reasonDetail === undefined ? {} : { reasonDetail }),
    occurredAt: isoDateTime(row[field("occurred_at")], field("occurred_at")),
    recordedAt: isoDateTime(row[field("recorded_at")], field("recorded_at")),
    payloadChecksum: string(row[field("payload_checksum")], field("payload_checksum")),
    ...(priorEventId === undefined ? {} : { priorEventId })
  };
}

async function resolveBook(client: PostgresQueryClient, scope: Scope): Promise<ResolvedBook> {
  const result = await client.query(
    `select "base_currency_code", "accounting_basis", "status"
from "erp_financials"."reporting_books"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3`,
    [scope.tenantId, scope.companyId, scope.bookId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ErpFinancialsError("missing_book", `Reporting book ${scope.bookId} does not exist`, {
      details: { bookId: scope.bookId }
    });
  }
  if (row.status !== "active") {
    throw new ErpFinancialsError("terminal_state_conflict", `Reporting book ${scope.bookId} is not active`, {
      details: { bookId: scope.bookId }
    });
  }
  return {
    currencyCode: string(row.base_currency_code, "base_currency_code"),
    accountingBasis: string(row.accounting_basis, "accounting_basis") as AccountingBasis
  };
}

function invoiceFromRow(row: Readonly<Record<string, unknown>>): InvoiceListItem {
  const provenance = string(row.provenance, "provenance") as InvoiceListItem["sourceProvenance"];
  const storedStatus = string(row.status, "status");
  const status = provenance === "draft" && storedStatus === "voided" ? "voided" : storedStatus;
  const partyName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  return {
    invoiceId: string(row.invoice_id, "invoice_id"),
    sourceId: string(row.source_id, "source_id"),
    sourceProvenance: provenance,
    customerId: string(row.party_id, "party_id"),
    ...(partyName === undefined ? {} : { customerName: partyName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    documentDate: date(row.document_date, "document_date"),
    ...(row.recognition_date == null ? {} : { recognitionDate: date(row.recognition_date, "recognition_date") }),
    dueDate: date(row.due_date, "due_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    originalAmount: money(row.original_amount, "original_amount"),
    openAmount: money(row.open_amount, "open_amount"),
    status: status as InvoiceListStatus,
    version: integer(row.version, "version")
  };
}

function customerStatementSettlementFromRow(row: Readonly<Record<string, unknown>>, prefix = ""): CustomerStatementSettlementAmounts {
  const cashAppliedAmount = money(row[`${prefix}cash_applied_amount`], "cash_applied_amount");
  const creditAppliedAmount = money(row[`${prefix}credit_applied_amount`], "credit_applied_amount");
  const writeOffAppliedAmount = money(row[`${prefix}write_off_applied_amount`], "write_off_applied_amount");
  const amounts = [cashAppliedAmount, creditAppliedAmount, writeOffAppliedAmount].map(moneyMinor);
  if (amounts.some(amount => amount < 0n) || amounts.reduce((sum, amount) => sum + amount, 0n) !== moneyMinor(money(row[`${prefix}applied_amount`], "applied_amount"))) {
    throw new ErpFinancialsError("reconciliation_conflict", "Historical statement settlement classification does not reconcile");
  }
  return { cashAppliedAmount, creditAppliedAmount, writeOffAppliedAmount };
}

function customerStatementRowFromRow(row: Readonly<Record<string, unknown>>): CustomerStatementRow {
  const customerName = optionalString(row.customer_name);
  const documentNumber = optionalString(row.document_number);
  const dueDate = optionalDate(row.due_date, "due_date");
  return {
    settlement: customerStatementSettlementFromRow(row),
    invoiceId: string(row.invoice_id, "invoice_id"),
    customerId: string(row.customer_id, "customer_id"),
    ...(customerName === undefined ? {} : { customerName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    documentDate: date(row.document_date, "document_date"),
    ...(row.recognition_date == null ? {} : { recognitionDate: date(row.recognition_date, "recognition_date") }),
    ...(dueDate === undefined ? {} : { dueDate }),
    currencyCode: string(row.currency_code, "currency_code"),
    originalAmount: money(row.original_amount, "original_amount"),
    appliedAmount: money(row.applied_amount, "applied_amount"),
    openBalance: money(row.open_balance, "open_balance"),
    sourceIdentity: {
      sourceId: string(row.source_id, "source_id"),
      sourceSystem: string(row.source_system, "source_system"),
      providerEnvironment: string(row.provider_environment, "provider_environment"),
      transactionId: string(row.transaction_id, "transaction_id"),
      sourceTransactionId: string(row.source_transaction_id, "source_transaction_id"),
      sourceTransactionType: string(row.source_transaction_type, "source_transaction_type")
    },
    applications: customerStatementApplications(row.applications)
  };
}

function customerStatementApplications(value: unknown): readonly CustomerStatementApplicationEvidence[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("Stored customer statement applications must be an array");
  return parsed.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Stored customer statement application must be an object");
    const applicationType = string(candidate.applicationType, "applicationType");
    if (!new Set<string>(["customer_payment_to_invoice", "credit_to_invoice", "write_off_to_invoice"])
      .has(applicationType)) {
      throw new Error("Stored customer statement application type is invalid");
    }
    const sourceDocumentType = string(candidate.sourceDocumentType, "sourceDocumentType");
    if (!new Set<string>(["customer_payment", "credit_memo", "write_off"]).has(sourceDocumentType)) {
      throw new Error("Stored customer statement source document type is invalid");
    }
    const sourceDocumentNumber = optionalString(candidate.sourceDocumentNumber);
    const endedLifecycleEventId = optionalString(candidate.endedLifecycleEventId);
    return {
      applicationId: string(candidate.applicationId, "applicationId"),
      applicationType: applicationType as CustomerStatementApplicationEvidence["applicationType"],
      status: "applied",
      applicationDate: date(candidate.applicationDate, "applicationDate"),
      amount: money(candidate.amount, "amount"),
      currencyCode: string(candidate.currencyCode, "currencyCode"),
      sourceDocumentId: string(candidate.sourceDocumentId, "sourceDocumentId"),
      sourceDocumentType: sourceDocumentType as CustomerStatementApplicationEvidence["sourceDocumentType"],
      ...(sourceDocumentNumber === undefined ? {} : { sourceDocumentNumber }),
      sourceDocumentDate: date(candidate.sourceDocumentDate, "sourceDocumentDate"),
      sourceIdentity: {
        sourceId: string(candidate.sourceId, "sourceId"),
        sourceSystem: string(candidate.sourceSystem, "sourceSystem"),
        providerEnvironment: string(candidate.providerEnvironment, "providerEnvironment"),
        transactionId: string(candidate.transactionId, "transactionId"),
        sourceTransactionId: string(candidate.sourceTransactionId, "sourceTransactionId"),
        sourceTransactionType: string(candidate.sourceTransactionType, "sourceTransactionType")
      },
      appliedLifecycleEventId: string(candidate.appliedLifecycleEventId, "appliedLifecycleEventId"),
      ...(endedLifecycleEventId === undefined ? {} : { endedLifecycleEventId })
    };
  });
}

function customerStatementTotalsFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix = ""
): CustomerStatementTotals {
  return {
    settlement: customerStatementSettlementFromRow(row, prefix),
    invoiceCount: integer(row[`${prefix}invoice_count`], `${prefix}invoice_count`),
    invoicedAmount: money(row[`${prefix}invoiced_amount`], `${prefix}invoiced_amount`),
    appliedAmount: money(row[`${prefix}applied_amount`], `${prefix}applied_amount`),
    outstandingAmount: money(row[`${prefix}outstanding_amount`], `${prefix}outstanding_amount`)
  };
}

function customerStatementPageTotals(items: readonly CustomerStatementRow[]): CustomerStatementTotals {
  return items.reduce<CustomerStatementTotals>((totals, item) => {
    const aggregate = totals.settlement, settlement = item.settlement;
    if (aggregate === undefined || settlement === undefined) throw new ErpFinancialsError("reconciliation_conflict", "Statement settlement classification is missing");
    return {
      settlement: {
        cashAppliedAmount: addMoney(aggregate.cashAppliedAmount, settlement.cashAppliedAmount),
        creditAppliedAmount: addMoney(aggregate.creditAppliedAmount, settlement.creditAppliedAmount),
        writeOffAppliedAmount: addMoney(aggregate.writeOffAppliedAmount, settlement.writeOffAppliedAmount)
      },
      invoiceCount: totals.invoiceCount + 1,
      invoicedAmount: addMoney(totals.invoicedAmount, item.originalAmount),
      appliedAmount: addMoney(totals.appliedAmount, item.appliedAmount),
      outstandingAmount: addMoney(totals.outstandingAmount, item.openBalance)
    };
  }, {
    settlement: { cashAppliedAmount: "0.00", creditAppliedAmount: "0.00", writeOffAppliedAmount: "0.00" },
    invoiceCount: 0,
    invoicedAmount: "0.00",
    appliedAmount: "0.00",
    outstandingAmount: "0.00"
  });
}

function invoiceDeliveryFromRow(row: Readonly<Record<string, unknown>>): InvoiceDeliveryEvent {
  const recipientRef = optionalString(row.recipient_ref);
  return {
    deliveryEventId: string(row.delivery_event_id, "delivery_event_id"),
    invoiceId: string(row.invoice_id, "invoice_id"),
    status: string(row.delivery_status, "delivery_status") as InvoiceDeliveryEvent["status"],
    channel: string(row.channel, "channel"),
    ...(recipientRef === undefined ? {} : { recipientRef }),
    occurredAt: isoDateTime(row.occurred_at, "occurred_at"),
    lifecycleEventId: string(row.lifecycle_event_id, "lifecycle_event_id")
  };
}

function vendorBillFromRow(row: Readonly<Record<string, unknown>>): VendorBillListItem {
  const vendorName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  return {
    billId: string(row.bill_id, "bill_id"),
    sourceId: string(row.source_id, "source_id"),
    sourceProvenance: "posted",
    transactionId: string(row.transaction_id, "transaction_id"),
    vendorId: string(row.party_id, "party_id"),
    ...(vendorName === undefined ? {} : { vendorName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    documentDate: date(row.document_date, "document_date"),
    dueDate: date(row.due_date, "due_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    originalAmount: money(row.original_amount, "original_amount"),
    openAmount: money(row.open_amount, "open_amount"),
    status: string(row.status, "status") as VendorBillStatus,
    version: integer(row.version, "version"),
    ...(typeof row.payment_hold === "boolean" ? {
      paymentHold: row.payment_hold, paymentHoldReason: optionalString(row.payment_hold_reason) ?? null
    } : {})
  };
}

function vendorBillLineFromRow(row: Readonly<Record<string, unknown>>): VendorBillLineReadModel {
  const line = commercialLineFromRow(row);
  const sourceItemId = optionalString(row.source_item_id);
  const itemName = optionalString(row.item_name);
  const itemCategoryAccountId = optionalString(row.item_expense_account_id);
  const bookAccountKey = optionalString(row.book_account_key);
  const accountMappingId = optionalString(row.book_account_mapping_id);
  const sourceAccountId = optionalString(row.source_account_id);
  const sourceAccountName = optionalString(row.source_account_name);
  const customerId = optionalString(row.customer_party_id);
  const customerName = optionalString(row.customer_name);
  const sourceId = string(row.source_id, "source_id");
  return {
    ...line,
    sourceAccountKey: sourceAccountId ?? `${sourceId}:${line.accountId}`,
    ...(sourceAccountName === undefined ? {} : { sourceAccountName }),
    ...(bookAccountKey === undefined ? {} : { bookAccountKey }),
    accountMappingProvenance: accountMappingId === undefined ? "source_account" : "reporting_book_mapping",
    ...(accountMappingId === undefined ? {} : { accountMappingId }),
    ...(sourceItemId === undefined ? {} : { sourceItemId }),
    ...(itemName === undefined ? {} : { itemName }),
    ...(itemCategoryAccountId === undefined ? {} : { itemCategoryAccountId }),
    ...(customerId === undefined ? {} : { customerId }),
    ...(customerName === undefined ? {} : { customerName }),
    categoryMappingProvenance: line.itemId === undefined
      ? "uncategorized"
      : itemCategoryAccountId === line.accountId
        ? "item_expense_account"
        : "line_account_override"
  };
}

function vendorBillApplicationFromRow(
  row: Readonly<Record<string, unknown>>
): VendorBillApplicationReadModel {
  return {
    applicationId: string(row.application_id, "application_id"),
    sourcePaymentId: string(row.source_payment_id, "source_payment_id"),
    applicationDate: date(row.application_date, "application_date"),
    amount: money(row.applied_amount, "applied_amount"),
    status: string(row.status, "status") as VendorBillApplicationReadModel["status"],
    version: integer(row.version, "version")
  };
}

function paymentFromRow(row: Readonly<Record<string, unknown>>): PaymentListItem {
  const amount = money(row.original_amount, "original_amount");
  const unapplied = money(row.open_amount, "open_amount");
  const returnedAmount = money(row.returned_amount, "returned_amount");
  const voided = row.document_status === "voided" || row.payment_status === "voided";
  const retainedAmount = voided ? "0.00" : subtractMoney(amount, returnedAmount);
  const storedStatus = optionalString(row.payment_status);
  const partyName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  const collectionRef = optionalString(row.collection_ref);
  if (collectionRef !== undefined && (!collectionRef.trim() || collectionRef.length > 512)) throw new ErpFinancialsError("invalid_input", "Stored receipt collection reference is invalid");
  return {
    ...(collectionRef === undefined ? {} : { collectionRef }),
    paymentId: string(row.payment_id, "payment_id"),
    sourceId: string(row.source_id, "source_id"),
    paymentType: string(row.document_type, "document_type") as PaymentListItem["paymentType"],
    transactionId: string(row.transaction_id, "transaction_id"),
    partyId: string(row.party_id, "party_id"),
    ...(partyName === undefined ? {} : { partyName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    paymentDate: date(row.document_date, "document_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    amount,
    unappliedAmount: unapplied,
    returnedAmount,
    retainedAmount,
    status: voided ? "voided" : returnedAmount === amount ? "returned" : storedStatus === undefined
      ? unapplied === "0.00" ? "applied" : unapplied === amount ? "unapplied" : "partial"
      : storedStatus as PaymentStatus,
    version: integer(row.version, "version"),
    lifecycleEventId: string(row.lifecycle_event_id, "lifecycle_event_id"),
    matchedApplicationCount: integer(row.application_count, "application_count")
  };
}

function billPaymentFromRow(row: Readonly<Record<string, unknown>>): BillPaymentListItem {
  const vendorName = optionalString(row.vendor_name);
  const documentNumber = optionalString(row.document_number);
  const paymentMethodValue = optionalString(row.payment_method);
  if (paymentMethodValue !== undefined && !BILL_PAYMENT_METHODS.has(paymentMethodValue as BillPaymentMethod)) {
    throw new Error(`Stored bill payment method ${paymentMethodValue} is invalid`);
  }
  const reference = optionalString(row.payment_reference);
  const fundingAccountId = optionalString(row.funding_account_id);
  const payableAccountId = optionalString(row.payable_account_id);
  const transactionId = optionalString(row.transaction_id);
  const unappliedAmount = row.unapplied_amount == null ? undefined : money(row.unapplied_amount, "unapplied_amount");
  const documentVersion = optionalInteger(row.document_version, "document_version");
  const lifecycleEventId = optionalString(row.lifecycle_event_id);
  const applicationStatusValue = optionalString(row.application_status);
  if (applicationStatusValue !== undefined && !PAYMENT_STATUSES.has(applicationStatusValue as PaymentStatus)) {
    throw new Error(`Stored bill payment application status ${applicationStatusValue} is invalid`);
  }
  return {
    paymentId: string(row.payment_id, "payment_id"),
    sourceId: string(row.source_id, "source_id"),
    paymentType: "bill_payment",
    vendorId: string(row.vendor_id, "vendor_id"),
    partyId: string(row.vendor_id, "vendor_id"),
    ...(vendorName === undefined ? {} : { vendorName }),
    ...(vendorName === undefined ? {} : { partyName: vendorName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    paymentDate: date(row.payment_date, "payment_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    amount: money(row.amount, "amount"),
    status: string(row.status, "status") as BillPaymentLifecycleStatus,
    version: integer(row.version, "version"),
    ...(paymentMethodValue === undefined ? {} : { paymentMethod: paymentMethodValue as BillPaymentMethod }),
    ...(reference === undefined ? {} : { reference }),
    ...(fundingAccountId === undefined ? {} : { fundingAccountId }),
    ...(payableAccountId === undefined ? {} : { payableAccountId }),
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(unappliedAmount === undefined ? {} : { unappliedAmount }),
    ...(documentVersion === undefined ? {} : { documentVersion }),
    ...(lifecycleEventId === undefined ? {} : { lifecycleEventId }),
    ...(applicationStatusValue === undefined ? {} : { applicationStatus: applicationStatusValue as PaymentStatus }),
    matchedApplicationCount: integer(row.application_count, "application_count")
  };
}

function orderBillPaymentApplications(
  applications: readonly PaymentApplicationListItem[],
  allocationsValue: unknown
): readonly PaymentApplicationListItem[] {
  if (allocationsValue === null || allocationsValue === undefined) return applications;
  const parsed = typeof allocationsValue === "string" ? JSON.parse(allocationsValue) as unknown : allocationsValue;
  if (!Array.isArray(parsed)) throw new Error("Stored bill payment allocations must be an array");
  const order = new Map<string, number>();
  parsed.forEach((allocation, index) => {
    if (typeof allocation === "object" && allocation !== null && !Array.isArray(allocation)) {
      const billId = optionalString((allocation as Readonly<Record<string, unknown>>).billId);
      if (billId !== undefined) order.set(billId, index);
    }
  });
  return [...applications].sort((left, right) =>
    (order.get(left.targetDocumentId) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.targetDocumentId) ?? Number.MAX_SAFE_INTEGER)
  );
}

function accountEvidenceFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix: "funding" | "payable"
): BillPaymentAccountEvidence | undefined {
  const accountId = optionalString(row[`${prefix}_account_id`]);
  if (accountId === undefined) return undefined;
  const postingId = optionalString(row[`${prefix}_posting_id`]);
  const debitAmount = row[`${prefix}_debit_amount`] == null
    ? undefined
    : money(row[`${prefix}_debit_amount`], `${prefix}_debit_amount`);
  const creditAmount = row[`${prefix}_credit_amount`] == null
    ? undefined
    : money(row[`${prefix}_credit_amount`], `${prefix}_credit_amount`);
  return {
    accountId,
    ...(postingId === undefined ? {} : { postingId }),
    ...(debitAmount === undefined ? {} : { debitAmount }),
    ...(creditAmount === undefined ? {} : { creditAmount })
  };
}

function paymentApplicationFromRow(row: Readonly<Record<string, unknown>>): PaymentApplicationListItem {
  const endedLifecycleEventId = optionalString(row.ended_event_id);
  const matchCandidateId = optionalString(row.match_candidate_id);
  const evidence = optionalJson(row.match_evidence);
  const matchProvenance = matchCandidateId === undefined ? undefined : {
    matchCandidateId,
    matchDecisionId: string(row.match_decision_id, "match_decision_id"),
    method: string(row.match_method, "match_method") as PaymentApplicationMatchProvenance["method"],
    score: decimal(row.match_score, "match_score"),
    ...(evidence === undefined ? {} : { evidence })
  };
  return {
    applicationId: string(row.application_id, "application_id"),
    sourceId: string(row.source_id, "source_id"),
    applicationType: string(row.application_type, "application_type") as PaymentApplicationListItem["applicationType"],
    status: string(row.status, "status") as PaymentApplicationListItem["status"],
    version: integer(row.version, "version"),
    applicationDate: date(row.application_date, "application_date"),
    sourcePaymentId: string(row.source_payment_id, "source_payment_id"),
    targetDocumentId: string(row.target_document_id, "target_document_id"),
    amount: money(row.applied_amount, "applied_amount"),
    currencyCode: string(row.currency_code, "currency_code"),
    appliedLifecycleEventId: string(row.applied_event_id, "applied_event_id"),
    ...(endedLifecycleEventId === undefined ? {} : { endedLifecycleEventId }),
    ...(matchProvenance === undefined ? {} : { matchProvenance })
  };
}

function writeOffFromRow(row: Readonly<Record<string, unknown>>): WriteOffListItem {
  const metadata = requiredObjectProperty(row.metadata, "writeOffProvenance");
  const customerName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  const relatedInvoiceId = optionalString(metadata.relatedInvoiceId);
  const reason = optionalString(metadata.reason);
  const reversalTransactionId = optionalString(row.reversal_transaction_id);
  const replacementWriteOffId = optionalString(row.replacement_write_off_id);
  const replacesWriteOffId = optionalString(row.replaces_write_off_id);
  return {
    writeOffId: string(row.write_off_id, "write_off_id"),
    sourceId: string(row.source_id, "source_id"),
    transactionId: string(row.transaction_id, "transaction_id"),
    customerId: string(row.party_id, "party_id"),
    ...(customerName === undefined ? {} : { customerName }),
    ...(relatedInvoiceId === undefined ? {} : { relatedInvoiceId }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    writeOffDate: date(row.document_date, "document_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    amount: money(row.original_amount, "original_amount"),
    status: string(row.status, "status") as WriteOffListItem["status"],
    version: integer(row.version, "version"),
    ...(reason === undefined ? {} : { reason }),
    ...(reversalTransactionId === undefined ? {} : { reversalTransactionId }),
    ...(replacementWriteOffId === undefined ? {} : { replacementWriteOffId }),
    ...(replacesWriteOffId === undefined ? {} : { replacesWriteOffId })
  };
}

function adjustmentFromRow(row: Readonly<Record<string, unknown>>): AdjustmentListItem {
  const customerName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  const reversalTransactionId = optionalString(row.reversal_transaction_id);
  const replacementAdjustmentId = optionalString(row.replacement_adjustment_id);
  const replacesAdjustmentId = optionalString(row.replaces_adjustment_id);
  return {
    adjustmentId: string(row.adjustment_id, "adjustment_id"),
    sourceId: string(row.source_id, "source_id"),
    transactionId: string(row.transaction_id, "transaction_id"),
    adjustmentType: string(row.adjustment_type, "adjustment_type") as AdjustmentType,
    customerId: string(row.party_id, "party_id"),
    ...(customerName === undefined ? {} : { customerName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    adjustmentDate: date(row.document_date, "document_date"),
    currencyCode: string(row.currency_code, "currency_code"),
    originalAmount: money(row.original_amount, "original_amount"),
    remainingAmount: money(row.open_amount, "open_amount"),
    status: string(row.status, "status") as AdjustmentStatus,
    version: integer(row.version, "version"),
    ...(reversalTransactionId === undefined ? {} : { reversalTransactionId }),
    ...(replacementAdjustmentId === undefined ? {} : { replacementAdjustmentId }),
    ...(replacesAdjustmentId === undefined ? {} : { replacesAdjustmentId })
  };
}

function adjustmentPostingFromRow(row: Readonly<Record<string, unknown>>): AdjustmentPostingReadModel {
  const itemId = optionalString(row.item_id);
  const description = optionalString(row.description);
  const dimensionRefs = typeof row.dimension_refs === "string"
    ? JSON.parse(row.dimension_refs) as JsonValue
    : row.dimension_refs as JsonValue;
  return {
    postingId: string(row.posting_id, "posting_id"),
    accountId: string(row.account_id, "account_id"),
    bookAccountKey: string(row.book_account_key, "book_account_key"),
    accountName: string(row.account_name, "account_name"),
    ...(itemId === undefined ? {} : { itemId }),
    ...(description === undefined ? {} : { description }),
    debitAmount: money(row.debit_amount, "debit_amount"),
    creditAmount: money(row.credit_amount, "credit_amount"),
    currencyCode: string(row.currency_code, "currency_code"),
    dimensionRefs
  };
}

function adjustmentApplicationFromRow(row: Readonly<Record<string, unknown>>): AdjustmentApplicationReadModel {
  return {
    applicationId: string(row.application_id, "application_id"),
    invoiceId: string(row.invoice_id, "invoice_id"),
    applicationDate: date(row.application_date, "application_date"),
    amount: money(row.applied_amount, "applied_amount"),
    status: string(row.status, "status") as AdjustmentApplicationReadModel["status"],
    version: integer(row.version, "version")
  };
}

function ledgerLineFromRow(row: Readonly<Record<string, unknown>>): GeneralLedgerLine {
  const transactionLineId = optionalString(row.transaction_line_id);
  const transactionLineNumber = row.transaction_line_number == null ? undefined : integer(row.transaction_line_number, "transaction_line_number");
  if ((transactionLineId === undefined) !== (transactionLineNumber === undefined)) throw new ErpFinancialsError("invalid_input", "Canonical journal line linkage is incomplete");
  const dimensions = generalLedgerDimensions(row.dimension_refs);
  const sourcePayloadRef = optionalRecord(row.source_payload_ref, "source_payload_ref");
  const optionalFields = {
    transactionNumber: optionalString(row.transaction_number),
    accountNumber: optionalString(row.account_number),
    partyId: optionalString(row.party_id),
    itemId: optionalString(row.item_id),
    description: optionalString(row.description)
  };
  return {
    postingId: string(row.posting_id, "posting_id"),
    ...(transactionLineId === undefined || transactionLineNumber === undefined ? {} : { transactionLineId, transactionLineNumber }),
    sourceId: string(row.source_id, "source_id"),
    transactionId: string(row.transaction_id, "transaction_id"),
    ...(optionalFields.transactionNumber === undefined ? {} : { transactionNumber: optionalFields.transactionNumber }),
    transactionDate: date(row.transaction_date, "transaction_date"),
    postingDate: date(row.posting_date, "posting_date"),
    accountingBasis: string(row.accounting_basis, "accounting_basis") as AccountingBasis,
    transactionType: boundedStoredString(row.source_transaction_type, "source_transaction_type", 200),
    accountId: string(row.account_id, "account_id"),
    bookAccountKey: string(row.book_account_key, "book_account_key"),
    ...(optionalFields.accountNumber === undefined ? {} : { accountNumber: optionalFields.accountNumber }),
    accountName: string(row.account_name, "account_name"),
    ...(optionalFields.partyId === undefined ? {} : { partyId: optionalFields.partyId }),
    ...(optionalFields.itemId === undefined ? {} : { itemId: optionalFields.itemId }),
    ...(optionalFields.description === undefined ? {} : { description: optionalFields.description }),
    debitAmount: money(row.debit_amount, "debit_amount"),
    creditAmount: money(row.credit_amount, "credit_amount"),
    netAmount: money(row.net_amount, "net_amount"),
    currencyCode: string(row.currency_code, "currency_code"),
    dimensions: dimensions.slice(0, GENERAL_LEDGER_MAX_DIMENSIONS),
    omittedDimensionCount: Math.max(0, dimensions.length - GENERAL_LEDGER_MAX_DIMENSIONS),
    sourceProvenance: {
      sourceId: string(row.source_id, "source_id"),
      sourceRole: reportingBookSourceRole(row.source_role),
      sourceSystem: boundedStoredString(row.source_system, "source_system", 200),
      providerEnvironment: boundedStoredString(row.provider_environment, "provider_environment", 100),
      sourceTransactionType: boundedStoredString(row.source_transaction_type, "source_transaction_type", 200),
      sourceTransactionId: boundedStoredString(row.source_transaction_id, "source_transaction_id", 300),
      sourcePostingId: boundedStoredString(row.source_posting_id, "source_posting_id", 300),
      ...sourceRefFields(sourcePayloadRef)
    }
  };
}

const GENERAL_LEDGER_MAX_FILTER_TEXT = 200;
const GENERAL_LEDGER_MAX_SEARCH_TEXT = 100;
const GENERAL_LEDGER_MAX_DIMENSIONS = 20;
const GENERAL_LEDGER_MAX_PROVENANCE_TEXT = 300;

type ValidatedGeneralLedgerFilters = GeneralLedgerFilters;

function generalLedgerFilters(input: GeneralLedgerFilters): ValidatedGeneralLedgerFilters {
  assertWindow(input.periodStart, input.periodEnd);
  assertReportAccountingMethod(input.accountingMethod);
  const accountKey = ledgerFilterText(input.accountKey, "accountKey");
  const sourceId = ledgerFilterText(input.sourceId, "sourceId");
  const transactionType = ledgerFilterText(input.transactionType, "transactionType");
  const classId = ledgerFilterText(input.classId, "classId");
  const dimensionKind = ledgerFilterText(input.dimensionKind, "dimensionKind");
  const dimensionId = ledgerFilterText(input.dimensionId, "dimensionId");
  if ((dimensionKind === undefined) !== (dimensionId === undefined)) {
    throw new ErpFinancialsError("invalid_input", "dimensionKind and dimensionId must be supplied together");
  }
  if (input.polarity !== undefined && !new Set<string>(["debit", "credit"]).has(input.polarity)) {
    throw new ErpFinancialsError("invalid_input", "polarity must be debit or credit");
  }
  const search = ledgerFilterText(input.search, "search", GENERAL_LEDGER_MAX_SEARCH_TEXT);
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ...(input.accountingMethod === undefined ? {} : { accountingMethod: input.accountingMethod }),
    ...(accountKey === undefined ? {} : { accountKey }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(transactionType === undefined ? {} : { transactionType }),
    ...(classId === undefined ? {} : { classId }),
    ...(dimensionKind === undefined ? {} : { dimensionKind }),
    ...(dimensionId === undefined ? {} : { dimensionId }),
    ...(input.polarity === undefined ? {} : { polarity: input.polarity }),
    ...(search === undefined ? {} : { search })
  };
}

function assertReportAccountingMethod(value: unknown): asserts value is ReportAccountingMethod | undefined {
  if (value !== undefined && value !== "cash" && value !== "accrual") {
    throw new ErpFinancialsError("invalid_input", "accountingMethod must be cash or accrual");
  }
}

function ledgerFilterText(value: string | undefined, field: string, max = GENERAL_LEDGER_MAX_FILTER_TEXT): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ErpFinancialsError("invalid_input", `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new ErpFinancialsError("invalid_input", `${field} must contain between 1 and ${String(max)} characters`);
  }
  return normalized;
}

function generalLedgerFilterFingerprint(filters: ValidatedGeneralLedgerFilters): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 20);
}

function generalLedgerDimensions(value: unknown): readonly GeneralLedgerDimensionProvenance[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error("Stored dimension_refs must be an array");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Stored dimension_refs[${String(index)}] must be an object`);
    const dimensionKind = boundedStoredString(entry.dimensionKind, `dimension_refs[${String(index)}].dimensionKind`, 200);
    const dimensionId = optionalBoundedStoredString(entry.dimensionId, `dimension_refs[${String(index)}].dimensionId`);
    const sourceDimensionId = optionalBoundedStoredString(entry.sourceDimensionId, `dimension_refs[${String(index)}].sourceDimensionId`);
    const name = optionalBoundedStoredString(entry.name, `dimension_refs[${String(index)}].name`);
    return {
      dimensionKind,
      ...(dimensionId === undefined ? {} : { dimensionId }),
      ...(sourceDimensionId === undefined ? {} : { sourceDimensionId }),
      ...(name === undefined ? {} : { name })
    };
  });
}

function sourceRefFields(value: Readonly<Record<string, unknown>> | undefined): Partial<GeneralLedgerSourceProvenance> {
  if (value === undefined) return {};
  const sourceObjectType = optionalBoundedStoredString(value.sourceObjectType, "source_payload_ref.sourceObjectType");
  const sourceObjectId = optionalBoundedStoredString(value.sourceObjectId, "source_payload_ref.sourceObjectId");
  const checksum = optionalBoundedStoredString(value.checksum, "source_payload_ref.checksum");
  const sourceUpdatedAtValue = optionalString(value.sourceUpdatedAt);
  if (sourceUpdatedAtValue !== undefined && Number.isNaN(Date.parse(sourceUpdatedAtValue))) {
    throw new Error("Stored source_payload_ref.sourceUpdatedAt must be a date-time");
  }
  return {
    ...(sourceObjectType === undefined ? {} : { sourceObjectType }),
    ...(sourceObjectId === undefined ? {} : { sourceObjectId }),
    ...(sourceUpdatedAtValue === undefined ? {} : { sourceUpdatedAt: sourceUpdatedAtValue }),
    ...(checksum === undefined ? {} : { checksum })
  };
}

function optionalRecord(value: unknown, field: string): Readonly<Record<string, unknown>> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)) throw new Error(`Stored ${field} must be an object`);
  return parsed;
}

function boundedStoredString(value: unknown, field: string, max = GENERAL_LEDGER_MAX_PROVENANCE_TEXT): string {
  const result = string(value, field);
  if (result.length > max) throw new Error(`Stored ${field} exceeds the public ${String(max)} character bound`);
  return result;
}

function optionalBoundedStoredString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return boundedStoredString(value, field);
}

function reportingBookSourceRole(value: unknown): GeneralLedgerSourceProvenance["sourceRole"] {
  if (value !== "historical" && value !== "active" && value !== "adjustment") {
    throw new Error("Stored source_role must be historical, active, or adjustment");
  }
  return value;
}

function chartAccountFromRow(row: Readonly<Record<string, unknown>>, currencyCode: IsoCurrencyCode): ChartOfAccountsItem {
  const accountNumber = optionalString(row.account_number);
  const type = optionalString(row.account_type);
  const subtype = optionalString(row.account_subtype);
  const accountRole = optionalReportingBookAccountRole(row.account_role);
  const version = optionalInteger(row.version, "version");
  const parentBookAccountKey = optionalString(row.parent_book_account_key);
  if (!Array.isArray(row.source_account_ids) || !row.source_account_ids.every((value) => typeof value === "string")) {
    throw new Error("Stored source_account_ids must be an array of strings");
  }
  return {
    bookAccountKey: string(row.book_account_key, "book_account_key"),
    sourceAccountIds: row.source_account_ids,
    ...(accountNumber === undefined ? {} : { accountNumber }),
    name: string(row.account_name, "account_name"),
    classification: string(row.classification, "classification") as AccountClassification,
    ...(type === undefined ? {} : { type }),
    ...(subtype === undefined ? {} : { subtype }),
    ...(accountRole === undefined ? {} : { accountRole }),
    ...(version === undefined ? {} : { version }),
    ...(parentBookAccountKey === undefined ? {} : { parentBookAccountKey }),
    active: row.active === true,
    debitAmount: money(row.debit_amount, "debit_amount"),
    creditAmount: money(row.credit_amount, "credit_amount"),
    directBalance: money(row.balance, "balance"),
    balance: money(row.balance, "balance"),
    currencyCode
  };
}

function mergeBookChartAccounts(
  sourceAccounts: readonly ChartOfAccountsItem[],
  bookRows: readonly Readonly<Record<string, unknown>>[],
  currencyCode: IsoCurrencyCode
): readonly ChartOfAccountsItem[] {
  const remaining = new Map(sourceAccounts.map((account) => [account.bookAccountKey, account]));
  const canonical = bookRows.map((row): ChartOfAccountsItem => {
    const bookAccountKey = string(row.book_account_key, "book_account_key");
    const source = remaining.get(bookAccountKey);
    remaining.delete(bookAccountKey);
    const accountNumber = optionalString(row.account_number);
    const type = optionalString(row.account_type);
    const subtype = optionalString(row.account_subtype);
    const accountRole = optionalReportingBookAccountRole(row.account_role);
    const version = optionalInteger(row.version, "version");
    const parentBookAccountKey = optionalString(row.parent_book_account_key);
    return {
      bookAccountKey,
      sourceAccountIds: source?.sourceAccountIds ?? [],
      ...(accountNumber === undefined ? {} : { accountNumber }),
      name: string(row.account_name, "account_name"),
      classification: string(row.classification, "classification") as AccountClassification,
      ...(type === undefined ? {} : { type }),
      ...(subtype === undefined ? {} : { subtype }),
      ...(accountRole === undefined ? {} : { accountRole }),
      ...(version === undefined ? {} : { version }),
      ...(parentBookAccountKey === undefined ? {} : { parentBookAccountKey }),
      active: row.active === true,
      debitAmount: source?.debitAmount ?? "0.00",
      creditAmount: source?.creditAmount ?? "0.00",
      directBalance: source?.directBalance ?? "0.00",
      balance: source?.directBalance ?? "0.00",
      currencyCode
    };
  });
  return [...canonical, ...remaining.values()];
}

function rollupChartAccounts(accounts: readonly ChartOfAccountsItem[]): readonly ChartOfAccountsItem[] {
  const byKey = new Map(accounts.map((account) => [account.bookAccountKey, account]));
  const children = new Map<string, ChartOfAccountsItem[]>();
  for (const account of accounts) {
    if (account.parentBookAccountKey !== undefined && byKey.has(account.parentBookAccountKey)) {
      const entries = children.get(account.parentBookAccountKey) ?? [];
      entries.push(account);
      children.set(account.parentBookAccountKey, entries);
    }
  }
  const memo = new Map<string, Pick<ChartOfAccountsItem, "debitAmount" | "creditAmount" | "balance">>();
  const visit = (account: ChartOfAccountsItem, path: ReadonlySet<string>): Pick<ChartOfAccountsItem, "debitAmount" | "creditAmount" | "balance"> => {
    const cached = memo.get(account.bookAccountKey);
    if (cached !== undefined) return cached;
    if (path.has(account.bookAccountKey)) throw new ErpFinancialsError("invalid_account_hierarchy", "Reporting-book account hierarchy contains a cycle");
    const nextPath = new Set(path).add(account.bookAccountKey);
    const total = (children.get(account.bookAccountKey) ?? []).reduce(
      (current, child) => {
        const childTotal = visit(child, nextPath);
        return {
          debitAmount: addMoney(current.debitAmount, childTotal.debitAmount),
          creditAmount: addMoney(current.creditAmount, childTotal.creditAmount),
          balance: addMoney(current.balance, childTotal.balance)
        };
      },
      { debitAmount: account.debitAmount, creditAmount: account.creditAmount, balance: account.directBalance }
    );
    memo.set(account.bookAccountKey, total);
    return total;
  };
  return orderAccountHierarchy(
    accounts.map((account) => ({ ...account, ...visit(account, new Set()) })),
    (account) => account.bookAccountKey,
    (account) => account.parentBookAccountKey
  );
}

function visibleChartAccounts(
  accounts: readonly ChartOfAccountsItem[],
  includeInactive: boolean
): readonly ChartOfAccountsItem[] {
  if (includeInactive) return accounts;
  const children = new Map<string, ChartOfAccountsItem[]>();
  for (const account of accounts) {
    if (account.parentBookAccountKey === undefined) continue;
    const entries = children.get(account.parentBookAccountKey) ?? [];
    entries.push(account);
    children.set(account.parentBookAccountKey, entries);
  }
  const retained = new Map<string, boolean>();
  const retain = (account: ChartOfAccountsItem): boolean => {
    const cached = retained.get(account.bookAccountKey);
    if (cached !== undefined) return cached;
    const visible = account.active || account.directBalance !== "0.00" ||
      (children.get(account.bookAccountKey) ?? []).some(retain);
    retained.set(account.bookAccountKey, visible);
    return visible;
  };
  return accounts.filter(retain);
}

function statementLineFromRow(row: Readonly<Record<string, unknown>>): FinancialStatementLine {
  const classification = string(row.classification, "classification") as AccountClassification;
  const net = money(row.net_amount, "net_amount");
  const amount = ["liability", "equity", "income", "other_income"].includes(classification)
    ? minorMoney(-moneyMinor(net))
    : net;
  const parentBookAccountKey = optionalString(row.parent_book_account_key);
  const accountNumber = optionalString(row.account_number);
  return {
    bookAccountKey: string(row.book_account_key, "book_account_key"),
    ...(parentBookAccountKey === undefined ? {} : { parentBookAccountKey }),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    name: string(row.account_name, "account_name"),
    classification,
    directAmount: amount,
    amount,
    debitAmount: money(row.debit_amount, "debit_amount"),
    creditAmount: money(row.credit_amount, "credit_amount")
  };
}

function derivedEquityStatementLine(
  key: "retained_earnings" | "net_income",
  name: string,
  amount: DecimalString
): FinancialStatementLine {
  const amountMinor = moneyMinor(amount);
  return {
    bookAccountKey: `__derived_equity__:${key}`,
    name,
    classification: "equity",
    directAmount: amount,
    amount,
    derivedAmount: amount,
    debitAmount: amountMinor < 0n ? minorMoney(-amountMinor) : "0.00",
    creditAmount: amountMinor > 0n ? amount : "0.00"
  };
}

function mergeBookStatementLines(
  sourceLines: readonly FinancialStatementLine[],
  bookRows: readonly Readonly<Record<string, unknown>>[]
): readonly FinancialStatementLine[] {
  const remaining = new Map(sourceLines.map((line) => [line.bookAccountKey, line]));
  const canonical = bookRows.map((row): FinancialStatementLine => {
    const bookAccountKey = string(row.book_account_key, "book_account_key");
    const source = remaining.get(bookAccountKey);
    remaining.delete(bookAccountKey);
    if (source !== undefined) return source;
    const parentBookAccountKey = optionalString(row.parent_book_account_key);
    const accountNumber = optionalString(row.account_number);
    return {
      bookAccountKey,
      ...(parentBookAccountKey === undefined ? {} : { parentBookAccountKey }),
      ...(accountNumber === undefined ? {} : { accountNumber }),
      name: string(row.account_name, "account_name"),
      classification: string(row.classification, "classification") as AccountClassification,
      directAmount: "0.00",
      amount: "0.00",
      debitAmount: "0.00",
      creditAmount: "0.00"
    };
  });
  return [...canonical, ...remaining.values()];
}

function rollupStatementLines(lines: readonly FinancialStatementLine[]): readonly FinancialStatementLine[] {
  const byKey = new Map(lines.map((line) => [line.bookAccountKey, line]));
  const children = new Map<string, FinancialStatementLine[]>();
  for (const line of lines) {
    if (line.parentBookAccountKey !== undefined && byKey.has(line.parentBookAccountKey)) {
      const entries = children.get(line.parentBookAccountKey) ?? [];
      entries.push(line);
      children.set(line.parentBookAccountKey, entries);
    }
  }
  type StatementTotal = Pick<FinancialStatementLine, "amount" | "debitAmount" | "creditAmount" | "derivedAmount">;
  const memo = new Map<string, StatementTotal>();
  const visit = (line: FinancialStatementLine, path: ReadonlySet<string>): StatementTotal => {
    const cached = memo.get(line.bookAccountKey);
    if (cached !== undefined) return cached;
    if (path.has(line.bookAccountKey)) throw new ErpFinancialsError("invalid_account_hierarchy", "Reporting-book account hierarchy contains a cycle");
    const nextPath = new Set(path).add(line.bookAccountKey);
    const total = (children.get(line.bookAccountKey) ?? []).reduce<StatementTotal>(
      (current, child) => {
        const childTotal = visit(child, nextPath);
        return {
          amount: addMoney(current.amount, childTotal.amount),
          debitAmount: addMoney(current.debitAmount, childTotal.debitAmount),
          creditAmount: addMoney(current.creditAmount, childTotal.creditAmount),
          ...(current.derivedAmount === undefined && childTotal.derivedAmount === undefined ? {} : {
            derivedAmount: addMoney(current.derivedAmount ?? "0.00", childTotal.derivedAmount ?? "0.00")
          })
        };
      },
      { amount: line.directAmount, debitAmount: line.debitAmount, creditAmount: line.creditAmount,
        ...(line.derivedAmount === undefined ? {} : { derivedAmount: line.derivedAmount }) }
    );
    memo.set(line.bookAccountKey, total);
    return total;
  };
  return orderAccountHierarchy(
    lines.map((line) => ({ ...line, ...visit(line, new Set()) })),
    (line) => line.bookAccountKey,
    (line) => line.parentBookAccountKey
  );
}

function orderAccountHierarchy<Item>(
  items: readonly Item[],
  keyFor: (item: Item) => string,
  parentFor: (item: Item) => string | undefined
): readonly Item[] {
  const byKey = new Map(items.map((item) => [keyFor(item), item]));
  const children = new Map<string | undefined, Item[]>();
  for (const item of items) {
    const parentKey = parentFor(item);
    const effectiveParent = parentKey !== undefined && byKey.has(parentKey) ? parentKey : undefined;
    const entries = children.get(effectiveParent) ?? [];
    entries.push(item);
    children.set(effectiveParent, entries);
  }
  const ordered: Item[] = [];
  const visited = new Set<string>();
  const visit = (item: Item): void => {
    const key = keyFor(item);
    if (visited.has(key)) return;
    visited.add(key);
    ordered.push(item);
    for (const child of children.get(key) ?? []) visit(child);
  };
  for (const root of children.get(undefined) ?? []) visit(root);
  for (const item of items) visit(item);
  return ordered;
}

function statementTotals(
  reportName: FinancialStatementName,
  lines: readonly FinancialStatementLine[]
): Readonly<Record<string, DecimalString>> {
  const known = new Set(lines.map((line) => line.bookAccountKey));
  const roots = lines.filter((line) => line.parentBookAccountKey === undefined || !known.has(line.parentBookAccountKey));
  const totalFor = (classifications: readonly AccountClassification[]) => roots
    .filter((line) => classifications.includes(line.classification))
    .reduce((total, line) => addMoney(total, line.amount), "0.00");
  if (reportName === "profit_and_loss") {
    const income = totalFor(["income", "other_income"]);
    const costOfGoodsSold = totalFor(["cost_of_goods_sold"]);
    const expenses = totalFor(["expense", "other_expense"]);
    return {
      income,
      costOfGoodsSold,
      grossProfit: subtractMoney(income, costOfGoodsSold),
      expenses,
      netIncome: subtractMoney(subtractMoney(income, costOfGoodsSold), expenses)
    };
  }
  if (reportName === "balance_sheet") {
    const assets = totalFor(["asset"]);
    const liabilities = totalFor(["liability"]);
    const equity = totalFor(["equity"]);
    return { assets, liabilities, equity, difference: subtractMoney(assets, addMoney(liabilities, equity)) };
  }
  const debits = roots.reduce((total, line) => addMoney(total, line.debitAmount), "0.00");
  const credits = roots.reduce((total, line) => addMoney(total, line.creditAmount), "0.00");
  return { debits, credits, difference: subtractMoney(debits, credits) };
}

function agingRowFromRow(row: Readonly<Record<string, unknown>>): AgingRow {
  const partyName = optionalString(row.party_name);
  return {
    partyId: string(row.party_id, "party_id"),
    ...(partyName === undefined ? {} : { partyName }),
    current: money(row.current_amount, "current_amount"),
    days1To30: money(row.days_1_30, "days_1_30"),
    days31To60: money(row.days_31_60, "days_31_60"),
    days61To90: money(row.days_61_90, "days_61_90"),
    daysOver90: money(row.days_over_90, "days_over_90"),
    total: money(row.total_amount, "total_amount")
  };
}

function commercialLineFromRow(row: Readonly<Record<string, unknown>>): CommercialDocumentLineReadModel {
  const itemId = optionalString(row.item_id);
  const description = optionalString(row.description);
  const taxCode = optionalString(row.tax_code);
  const servicePeriodStart = optionalDate(row.service_period_start, "service_period_start");
  const servicePeriodEnd = optionalDate(row.service_period_end, "service_period_end");
  const unitCost = row.unit_cost === null || row.unit_cost === undefined
    ? undefined
    : decimal(row.unit_cost, "unit_cost");
  const dimensionRefs = typeof row.dimension_refs === "string" ? JSON.parse(row.dimension_refs) as JsonValue : row.dimension_refs as JsonValue;
  return {
    lineId: string(row.line_id, "line_id"),
    lineNumber: integer(row.line_number, "line_number"),
    ...(optionalString(row.tax_account_id) === undefined ? {} : {taxAccountId:string(row.tax_account_id,"tax_account_id")}),
    ...(optionalString(row.discount_account_id) === undefined ? {} : {discountAccountId:string(row.discount_account_id,"discount_account_id")}),
    accountId: string(row.account_id, "account_id"),
    ...(optionalString(row.account_number) === undefined ? {} : { accountNumber: string(row.account_number, "account_number") }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(description === undefined ? {} : { description }),
    quantity: decimal(row.quantity, "quantity"),
    unitAmount: unitRate(row.unit_amount),
    ...(unitCost === undefined ? {} : { unitCost }),
    discountAmount: money(row.discount_amount, "discount_amount"),
    ...(taxCode === undefined ? {} : { taxCode }),
    taxAmount: money(row.tax_amount, "tax_amount"),
    ...(servicePeriodStart === undefined ? {} : { servicePeriodStart }),
    ...(servicePeriodEnd === undefined ? {} : { servicePeriodEnd }),
    dimensionRefs,
    amount: money(row.line_amount, "line_amount")
  };
}

function bankLineFromRow(row: Readonly<Record<string, unknown>>): BankReconciliationListItem {
  const description = optionalString(row.description);
  const reference = optionalString(row.reference);
  const status = string(row.status, "status");
  const base = {
    bankStatementLineId: string(row.bank_statement_line_id, "bank_statement_line_id"),
    sourceId: string(row.source_id, "source_id"),
    bankAccountId: string(row.bank_account_id, "bank_account_id"),
    externalLineId: string(row.external_line_id, "external_line_id"),
    postedDate: date(row.posted_date, "posted_date"),
    amount: money(row.amount, "amount"),
    currencyCode: string(row.currency_code, "currency_code"),
    ...(description === undefined ? {} : { description }),
    ...(reference === undefined ? {} : { reference }),
    version: integer(row.version, "version")
  };
  if (status === "matched") {
    const method = string(row.method, "method");
    if (method !== "automatic" && method !== "manual") throw new Error(`Stored reconciliation method ${method} is invalid`);
    return {
      ...base,
      status,
      bankReconciliationMatchId: string(row.bank_reconciliation_match_id, "bank_reconciliation_match_id"),
      bankReconciliationMatchVersion: integer(row.bank_reconciliation_match_version, "bank_reconciliation_match_version"),
      matchedTransactionId: string(row.transaction_id, "transaction_id"),
      matchMethod: method
    };
  }
  if (status === "unmatched" || status === "ignored") return { ...base, status };
  throw new Error(`Stored bank statement line status ${status} is invalid`);
}

function partyFromRow(row: Readonly<Record<string, unknown>>): PartyListItem {
  const partyType = string(row.party_type, "party_type");
  if (partyType !== "customer" && partyType !== "vendor" && partyType !== "employee" && partyType !== "other") {
    throw new Error(`Stored party_type ${partyType} is invalid`);
  }
  return {
    partyId: string(row.party_id, "party_id"),
    sourceId: string(row.source_id, "source_id"),
    sourcePartyId: string(row.source_party_id, "source_party_id"),
    partyType,
    displayName: string(row.display_name, "display_name"),
    active: row.active === true
  };
}

function operationalDocumentFromRow(row: Readonly<Record<string, unknown>>): OperationalDocumentListItem {
  const partyId = optionalString(row.party_id);
  const partyName = optionalString(row.party_name);
  const documentNumber = optionalString(row.document_number);
  const dueDate = optionalDate(row.due_date, "due_date");
  const sourceTransactionId = optionalString(row.source_transaction_id);
  const sourceTransactionType = optionalString(row.source_transaction_type);
  return {
    documentId: string(row.document_id, "document_id"),
    sourceId: string(row.source_id, "source_id"),
    sourceSystem: string(row.source_system, "source_system"),
    providerEnvironment: string(row.provider_environment, "provider_environment"),
    documentType: string(row.document_type, "document_type") as OperationalDocumentType,
    transactionId: string(row.transaction_id, "transaction_id"),
    ...(sourceTransactionId === undefined ? {} : { sourceTransactionId }),
    ...(sourceTransactionType === undefined ? {} : { sourceTransactionType }),
    ...(partyId === undefined ? {} : { partyId }),
    ...(partyName === undefined ? {} : { partyName }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    documentDate: date(row.document_date, "document_date"),
    ...(row.recognition_date == null ? {} : { recognitionDate: date(row.recognition_date, "recognition_date") }),
    ...(dueDate === undefined ? {} : { dueDate }),
    currencyCode: string(row.currency_code, "currency_code"),
    originalAmount: money(row.original_amount, "original_amount"),
    openAmount: money(row.open_amount, "open_amount"),
    status: string(row.status, "status") as OperationalDocumentStatus,
    version: integer(row.version, "version"),
    ...(typeof row.payment_hold === "boolean" ? {
      paymentHold: row.payment_hold, paymentHoldReason: optionalString(row.payment_hold_reason) ?? null
    } : {})
  };
}

type DecodedPage = { readonly limit: number; readonly date?: IsoDate; readonly id?: string };

function pageInput(input: PageRequest, kind: string, bookId: string): DecodedPage {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ErpFinancialsError("invalid_input", "Page limit must be an integer between 1 and 200");
  }
  if (input.cursor === undefined) return { limit };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new ErpFinancialsError("invalid_input", "Page cursor is invalid");
  }
  if (!isRecord(value) || value.v !== 1 || value.kind !== kind || value.bookId !== bookId ||
    typeof value.date !== "string" || typeof value.id !== "string") {
    throw new ErpFinancialsError("invalid_input", "Page cursor does not belong to this read model scope");
  }
  assertDate(value.date, "cursor.date");
  return { limit, date: value.date, id: value.id };
}

function toPage<Item>(
  values: readonly Item[],
  limit: number,
  kind: string,
  bookId: string,
  key: (item: Item) => { readonly date: IsoDate; readonly id: string }
): Page<Item> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  const last = items.at(-1);
  if (last === undefined) return { items };
  const cursorKey = key(last);
  return {
    items,
    nextCursor: Buffer.from(JSON.stringify({ v: 1, kind, bookId, ...cursorKey }), "utf8").toString("base64url")
  };
}

function today(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

function assertWindow(start: string, end: string): void {
  assertDate(start, "periodStart");
  assertDate(end, "periodEnd");
  if (start > end) throw new ErpFinancialsError("invalid_input", "periodStart must be on or before periodEnd");
}

function assertDate(value: string, field: string): asserts value is IsoDate {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a valid ISO date`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ErpFinancialsError("invalid_input", `${field} must not be empty`);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Stored ${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Stored optional value must be a string");
  return value;
}

function isoDateTime(value: unknown, field: string): IsoDateTime {
  const result = value instanceof Date ? value.toISOString() : string(value, field);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/u.test(result)) {
    throw new Error(`Stored ${field} must be an ISO date-time`);
  }
  return result;
}

function optionalJson(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return (typeof value === "string" ? JSON.parse(value) : value) as JsonValue;
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, JsonValue>> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Stored ${field} must be a JSON object`);
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function requiredObjectProperty(value: unknown, property: string): Readonly<Record<string, JsonValue>> {
  const object = jsonObject(value, "metadata");
  return jsonObject(object[property], `metadata.${property}`);
}

function customerPaymentProvenanceFromMetadata(value: unknown): CustomerPaymentProvenanceReadModel | undefined {
  const metadata = jsonObject(value, "metadata");
  const raw = metadata.customerPaymentProvenance;
  if (raw === undefined) return undefined;
  const provenance = jsonObject(raw, "metadata.customerPaymentProvenance");
  const bank = provenance.externalBankMatch === undefined
    ? undefined
    : jsonObject(provenance.externalBankMatch, "metadata.customerPaymentProvenance.externalBankMatch");
  const deposit = provenance.deposit === undefined
    ? undefined
    : jsonObject(provenance.deposit, "metadata.customerPaymentProvenance.deposit");
  const bankStatementLineId = optionalString(bank?.bankStatementLineId);
  const providerReference = optionalString(bank?.providerReference);
  const externalDepositReference = optionalString(deposit?.externalDepositReference);
  return {
    ...(bank === undefined ? {} : { externalBankMatch: {
      externalMatchId: string(bank.externalMatchId, "externalMatchId"),
      ...(bankStatementLineId === undefined ? {} : { bankStatementLineId }),
      ...(providerReference === undefined ? {} : { providerReference }),
      ...(bank.matchedAt === undefined ? {} : { matchedAt: isoDateTime(bank.matchedAt, "matchedAt") })
    } }),
    ...(deposit === undefined ? {} : { deposit: {
      depositId: string(deposit.depositId, "depositId"),
      ...(externalDepositReference === undefined ? {} : { externalDepositReference }),
      ...(deposit.depositedAt === undefined ? {} : { depositedAt: isoDateTime(deposit.depositedAt, "depositedAt") })
    } })
  };
}

function refundProvenanceFromMetadata(value: unknown): AdjustmentDetail["refundProvenance"] | undefined {
  if (value === undefined || value === null) return undefined;
  const metadata = jsonObject(value, "metadata");
  if (metadata.refundProvenance === undefined) return undefined;
  const provenance = jsonObject(metadata.refundProvenance, "metadata.refundProvenance");
  const relatedInvoiceId = optionalString(provenance.relatedInvoiceId);
  const refundMethod = optionalString(provenance.refundMethod);
  const lifecycleReference = optionalString(provenance.lifecycleReference);
  return {
    ...(relatedInvoiceId === undefined ? {} : { relatedInvoiceId }),
    ...(refundMethod === undefined ? {} : { refundMethod }),
    ...(lifecycleReference === undefined ? {} : { lifecycleReference })
  };
}

function lifecycleFromRow(row: Readonly<Record<string, unknown>>): FinancialLifecycleProvenance {
  const approverRef = optionalString(row.approver_ref);
  return {
    lifecycleEventId: string(row.lifecycle_event_id, "lifecycle_event_id"),
    actorRef: string(row.actor_ref, "actor_ref"),
    ...(approverRef === undefined ? {} : { approverRef }),
    requestId: string(row.request_id, "request_id"),
    reasonCode: string(row.reason_code, "reason_code")
  };
}

function prefixedLifecycleFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix: "scheduled" | "cleared" | "posted" | "voided"
): FinancialLifecycleProvenance {
  const approverRef = optionalString(row[`${prefix}_approver_ref`]);
  return {
    lifecycleEventId: string(row[`${prefix}_event_id`], `${prefix}_event_id`),
    actorRef: string(row[`${prefix}_actor_ref`], `${prefix}_actor_ref`),
    ...(approverRef === undefined ? {} : { approverRef }),
    requestId: string(row[`${prefix}_request_id`], `${prefix}_request_id`),
    reasonCode: string(row[`${prefix}_reason_code`], `${prefix}_reason_code`)
  };
}

function optionalPrefixedLifecycleFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix: "scheduled" | "cleared" | "posted" | "voided"
): FinancialLifecycleProvenance | undefined {
  return optionalString(row[`${prefix}_event_id`]) === undefined
    ? undefined
    : prefixedLifecycleFromRow(row, prefix);
}

function date(value: unknown, field: string): IsoDate {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : string(value, field).slice(0, 10);
  assertDate(result, field);
  return result;
}

function optionalDate(value: unknown, field: string): IsoDate | undefined {
  return value === null || value === undefined ? undefined : date(value, field);
}

function decimal(value: unknown, field: string): DecimalString {
  const result = typeof value === "number" ? String(value) : string(value, field);
  if (!/^-?\d+(?:\.\d+)?$/u.test(result)) throw new Error(`Stored ${field} must be decimal`);
  return result;
}

function unitRate(value: unknown): DecimalString {
  const [whole = "0", fraction = ""] = decimal(value, "unit_amount").split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function money(value: unknown, field: string): DecimalString {
  const parsed = decimal(value, field);
  const [whole = "0", fraction = ""] = parsed.split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function moneyMinor(value: DecimalString): bigint {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = raw.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -minor : minor;
}

function minorMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function addMoney(left: DecimalString, right: DecimalString): DecimalString {
  return minorMoney(moneyMinor(left) + moneyMinor(right));
}

function subtractMoney(left: DecimalString, right: DecimalString): DecimalString {
  return minorMoney(moneyMinor(left) - moneyMinor(right));
}

function percentage(numerator: number, denominator: number): DecimalString {
  if (denominator === 0) return "0.00";
  const basisPoints = (BigInt(numerator) * 10_000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return minorMoney(basisPoints);
}

function integer(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(result)) throw new Error(`Stored ${field} must be an integer`);
  return result;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return integer(value, field);
}

function optionalReportingBookAccountRole(value: unknown): ReportingBookAccountRole | undefined {
  if (value === null || value === undefined) return undefined;
  if (value !== "header" && value !== "posting") throw new Error("Stored account_role must be header or posting");
  return value;
}

function requiredRow(row: Readonly<Record<string, unknown>> | undefined, label: string): Readonly<Record<string, unknown>> {
  if (row === undefined) throw new Error(`Missing ${label} row`);
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCollectionPositionRequest(request: unknown): asserts request is ReceivableCollectionPositionRequest {
  if (!isRecord(request)) throw new ErpFinancialsError("invalid_input", "Collection request must be an object");
  for (const [field, value] of Object.entries({sourceId:request.sourceId,customerId:request.customerId,collectionRef:request.collectionRef})) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new ErpFinancialsError("invalid_input", `${field} must contain 1–512 characters`);
  }
  if ((request.invoiceId === undefined) === (request.unbilledAmount === undefined)) throw new ErpFinancialsError("invalid_input", "Provide either invoiceId or unbilledAmount");
  if (request.invoiceId !== undefined && (typeof request.invoiceId !== "string" || !request.invoiceId.trim() || request.invoiceId.length > 512)) throw new ErpFinancialsError("invalid_input", "invoiceId must contain 1–512 characters");
  if (request.unbilledAmount !== undefined && (typeof request.unbilledAmount !== "string" || !/^\d{1,16}(\.\d{1,2})?$/.test(request.unbilledAmount))) throw new ErpFinancialsError("invalid_input", "unbilledAmount must be nonnegative exact money");
}

async function getReceivableCollectionPosition(scope: Scope, request: ReceivableCollectionPositionRequest): Promise<ReceivableCollectionPosition> {
  const [position] = await getReceivableCollectionPositions(scope, { requests: [request] });
  if (position === undefined) throw new Error("Missing collection position result");
  return position;
}

function collectionPositionRequests(input: ReceivableCollectionPositionsRequest): readonly ReceivableCollectionPositionRequest[] {
  const raw: unknown = input;
  if (!isRecord(raw) || !Array.isArray(raw.requests) || raw.requests.length > 200) {
    throw new ErpFinancialsError("invalid_input", "Provide at most 200 collection requests");
  }
  const entries: readonly unknown[] = raw.requests;
  const requests = structuredClone(entries).map(request => {
    validateCollectionPositionRequest(request);
    return request;
  });
  const identities = new Set<string>();
  for (const request of requests) {
    const identity = JSON.stringify([request.sourceId, request.customerId, request.collectionRef]);
    if (identities.has(identity)) throw new ErpFinancialsError("invalid_input", "Collection request identities must be unique");
    identities.add(identity);
  }
  return requests;
}

async function withLockedReceivableCollectionPositions<Result>(scope: Scope, input: ReceivableCollectionPositionsRequest,
  work: (guard: ReceivableCollectionGuard) => Promise<Result>): Promise<Result> {
  const requests = collectionPositionRequests(input);
  if (!requests.length || typeof work !== "function") throw new ErpFinancialsError("invalid_input", "A collection guard requires 1–200 positions and an operational callback");
  const sources = [...new Set(requests.map(request => request.sourceId))].sort();
  return scope.database.transaction(async client => {
    const before = (await client.query(`select txid_current()::text as transaction_id,
      current_setting('transaction_isolation') as isolation`)).rows[0];
    if (before?.isolation !== "read committed") throw new ErpFinancialsError("invalid_input", "Collection guards require READ COMMITTED isolation");
    // Shared guards can run together. Native writers and managed imports use
    // the same source key exclusively, before any document/fiscal locks.
    await client.query(`select pg_advisory_xact_lock_shared(hashtextextended(lock_key,0))
      from unnest($1::text[]) as locks(lock_key) order by lock_key`,
      [sources.map(source => `payment-correction:${scope.tenantId}:${source}`)]);
    const after = (await client.query("select txid_current()::text as transaction_id")).rows[0];
    if (!before.transaction_id || before.transaction_id !== after?.transaction_id) {
      throw new ErpFinancialsError("invalid_input", "Collection guards require one explicit transaction client");
    }
    // Protect reporting-book status/currency and effective source windows too.
    const books = await client.query(`select book_id from erp_financials.reporting_books
      where tenant_id=$1 and company_id=$2 and book_id=$3 for share`, [scope.tenantId,scope.companyId,scope.bookId]);
    if (books.rows.length !== 1) throw new ErpFinancialsError("missing_book", "Collection reporting book does not exist");
    const bindings = await client.query(`select source_id from erp_financials.reporting_book_sources
      where tenant_id=$1 and company_id=$2 and book_id=$3 and source_id=any($4::text[]) order by source_id for share`,
      [scope.tenantId,scope.companyId,scope.bookId,sources]);
    if (bindings.rows.length !== sources.length) throw new ErpFinancialsError("missing_document", "Collection source is outside the reporting book");
    // READ COMMITTED gives this query a fresh snapshot after any waiting writer
    // commits. No callback runs with the snapshot from before the lock wait.
    const positions = await getReceivableCollectionPositions({...scope,database:{transaction:callback=>callback(client)}},{requests});
    return work({positions:Object.freeze(positions.map(position=>Object.freeze(position))),client});
  });
}

async function listUnappliedCollectionReceipts(scope: Scope, raw: CollectionReceiptPageRequest): Promise<Page<CollectionReceipt>> {
  const request = structuredClone(raw);
  validateCollectionPositionRequest({ sourceId: request.sourceId, customerId: request.customerId, collectionRef: request.collectionRef, unbilledAmount: "0.00" });
  if (request.cursor !== undefined && request.cursor.length > 4096) throw new ErpFinancialsError("invalid_input", "Collection receipt cursor is too large");
  const kind = `collection-receipts:${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.companyId, scope.bookId, request.sourceId, request.customerId, request.collectionRef])).digest("hex")}`;
  const page = pageInput(request, kind, scope.bookId);
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    const result = await client.query(`select d.subledger_document_id, d.source_id, d.party_id, d.document_date::text,
 d.currency_code, d.original_amount::text, d.open_amount::text, d.version, d.document_number
from erp_financials.subledger_documents d
join erp_financials.reporting_book_sources s on s.tenant_id=d.tenant_id and s.company_id=d.company_id and s.book_id=$3 and s.source_id=d.source_id
where d.tenant_id=$1 and d.company_id=$2 and d.source_id=$4 and d.party_id=$5 and d.metadata->>'collectionRef'=$6
 and d.document_type='customer_payment' and d.status not in ('voided','replaced') and d.open_amount>0 and d.currency_code=$7
 and (s.effective_from is null or s.effective_from<=d.document_date) and (s.effective_through is null or s.effective_through>=d.document_date)
 and ($8::date is null or (d.document_date,d.subledger_document_id)<($8::date,$9::text))
order by d.document_date desc,d.subledger_document_id desc limit $10`,
      [scope.tenantId, scope.companyId, scope.bookId, request.sourceId, request.customerId, request.collectionRef, book.currencyCode, page.date ?? null, page.id ?? null, page.limit + 1]);
    const items: CollectionReceipt[] = result.rows.map(row => ({ paymentId: string(row.subledger_document_id, "paymentId"), sourceId: string(row.source_id, "sourceId"),
      customerId: string(row.party_id, "customerId"), collectionRef: request.collectionRef, paymentDate: date(row.document_date, "paymentDate"),
      currencyCode: string(row.currency_code, "currencyCode"), originalAmount: money(row.original_amount, "originalAmount"), unappliedAmount: money(row.open_amount, "unappliedAmount"),
      version: integer(row.version, "version"), ...(row.document_number == null ? {} : { documentNumber: string(row.document_number, "documentNumber") }) }));
    return toPage(items, page.limit, kind, scope.bookId, item => ({ date: item.paymentDate, id: item.paymentId }));
  });
}

async function getReceivableCollectionPositions(scope: Scope, input: ReceivableCollectionPositionsRequest): Promise<readonly ReceivableCollectionPosition[]> {
  const requests = collectionPositionRequests(input);
  if (!requests.length) return [];
  return scope.database.transaction(async client => {
    const book = await resolveBook(client, scope);
    // Every requested financial position shares this one statement snapshot.
    // Joins are scoped to the bounded identity set; neither application history
    // nor per-request detail queries are loaded into application memory.
    const result = await client.query(`with requests as (
 select ordinality::integer as request_index,input->>'sourceId' as source_id,input->>'customerId' as customer_id,
 input->>'collectionRef' as collection_ref,input->>'invoiceId' as invoice_id,(input->>'unbilledAmount')::numeric as unbilled_amount
 from jsonb_array_elements($4::jsonb) with ordinality as x(input,ordinality)
), sources as (
 select r.*,s.source_id is not null as source_bound,s.effective_from,s.effective_through
 from requests r left join erp_financials.reporting_book_sources s
 on s.tenant_id=$1 and s.company_id=$2 and s.book_id=$3 and s.source_id=r.source_id
), draft as (
 select s.request_index,d.* from sources s join erp_financials.invoice_drafts d
 on d.tenant_id=$1 and d.company_id=$2 and d.book_id=$3 and d.source_id=s.source_id and d.invoice_draft_id=s.invoice_id
 where s.source_bound and (s.effective_from is null or s.effective_from<=d.document_date)
 and (s.effective_through is null or s.effective_through>=d.document_date)
), invoice as (
 select s.request_index,d.subledger_document_id as id,d.party_id as customer_id,d.currency_code,d.version,d.original_amount,d.open_amount,
 case when d.status in ('voided','replaced') or v.invoice_void_id is not null then 'voided' else 'invoice' end as basis
 from sources s join erp_financials.subledger_documents d
 on d.tenant_id=$1 and d.company_id=$2 and d.source_id=s.source_id and d.document_type='invoice'
 and d.subledger_document_id=coalesce((select issued_document_id from draft where request_index=s.request_index and status='issued'),s.invoice_id)
 left join erp_financials.invoice_voids v on v.tenant_id=d.tenant_id and v.company_id=d.company_id and v.book_id=$3 and v.source_id=d.source_id and v.invoice_document_id=d.subledger_document_id
 where s.source_bound and (s.effective_from is null or s.effective_from<=coalesce(d.recognition_date,d.document_date))
 and (s.effective_through is null or s.effective_through>=coalesce(d.recognition_date,d.document_date))
 union all
 select d.request_index,d.invoice_draft_id,d.customer_id,d.currency_code,d.version,coalesce(sum(l.line_amount),0),coalesce(sum(l.line_amount),0),case when d.status='voided' then 'voided' else 'draft' end
 from draft d left join erp_financials.invoice_draft_lines l on l.tenant_id=d.tenant_id and l.company_id=d.company_id and l.book_id=d.book_id and l.invoice_draft_id=d.invoice_draft_id
 where d.status<>'issued' group by d.request_index,d.invoice_draft_id,d.customer_id,d.currency_code,d.version,d.status
), receipts as materialized (
 select s.request_index,d.subledger_document_id,d.status,d.open_amount from sources s join erp_financials.subledger_documents d
 on d.tenant_id=$1 and d.company_id=$2 and d.source_id=s.source_id and d.document_type='customer_payment'
 and d.party_id=s.customer_id and d.currency_code=$5 and d.metadata->>'collectionRef'=s.collection_ref
 where s.source_bound and (s.effective_from is null or s.effective_from<=coalesce(d.recognition_date,d.document_date))
 and (s.effective_through is null or s.effective_through>=coalesce(d.recognition_date,d.document_date))
), receipt_totals as (
 select request_index,count(*)::text as receipt_count,coalesce(sum(open_amount) filter(where status not in ('voided','replaced')),0) as unallocated
 from receipts group by request_index
), applied as (
 select i.request_index,coalesce(sum(a.applied_amount),0) as amount from invoice i
 join sources s on s.request_index=i.request_index
 join erp_financials.subledger_applications a on a.tenant_id=$1 and a.company_id=$2 and a.source_id=s.source_id and a.target_document_id=i.id
 join erp_financials.subledger_documents p on p.tenant_id=a.tenant_id and p.company_id=a.company_id and p.source_id=a.source_id and p.subledger_document_id=a.source_document_id
 where (s.effective_from is null or s.effective_from<=p.document_date) and (s.effective_through is null or s.effective_through>=p.document_date)
 and i.basis='invoice' and a.status='applied' and a.application_type='customer_payment_to_invoice'
 and p.document_type='customer_payment' and p.party_id=s.customer_id and p.currency_code=$5 and p.status not in ('voided','replaced')
 group by i.request_index
)
select s.request_index,s.source_bound,(select count(*)::integer from invoice where request_index=s.request_index) as invoice_count,
 i.id,i.customer_id,i.currency_code,i.version,i.basis,i.original_amount::text,i.open_amount::text,
 coalesce(t.receipt_count,'0') as receipt_count,coalesce(t.unallocated,0)::text as unallocated,coalesce(a.amount,0)::text as applied,
 s.unbilled_amount::text as unbilled_amount
from sources s left join receipt_totals t on t.request_index=s.request_index
left join applied a on a.request_index=s.request_index left join invoice i on i.request_index=s.request_index
order by s.request_index`, [scope.tenantId,scope.companyId,scope.bookId,JSON.stringify(requests),book.currencyCode]);
    if (result.rows.length !== requests.length) throw new Error("Ambiguous collection position identities");
    return requests.map((request, index) => {
      const row = requiredRow(result.rows[index], "collection position");
      if (row.request_index !== index + 1) throw new Error("Collection position order mismatch");
      if (!row.source_bound) throw new ErpFinancialsError("missing_document", "Collection source is outside the reporting book");
      if (request.invoiceId !== undefined && (row.invoice_count !== 1 || row.customer_id !== request.customerId || row.currency_code !== book.currencyCode)) throw new ErpFinancialsError("missing_document", "Collection invoice does not match the requested customer, source and currency");
      const basis = request.invoiceId === undefined ? "unbilled" : string(row.basis,"basis") as ReceivableCollectionPosition["basis"];
      const originalAmount = money(request.invoiceId === undefined ? row.unbilled_amount : row.original_amount,"original_amount");
      const openInvoiceAmount = basis === "voided" ? "0.00" : money(request.invoiceId === undefined ? row.unbilled_amount : row.open_amount,"open_amount");
      const unallocatedCashAmount = money(row.unallocated,"unallocated"), appliedCashAmount = money(row.applied,"applied");
      const remaining = moneyMinor(openInvoiceAmount)-moneyMinor(unallocatedCashAmount);
      return {sourceId:request.sourceId,customerId:request.customerId,collectionRef:request.collectionRef,currencyCode:book.currencyCode,basis,
        ...(request.invoiceId === undefined ? {} : {invoiceId:string(row.id,"id"),invoiceVersion:integer(row.version,"version")}),
        originalAmount,openInvoiceAmount,unallocatedCashAmount,appliedCashAmount,
        cashCoverageAmount:addMoney(unallocatedCashAmount,appliedCashAmount),collectionAmount:minorMoney(remaining>0n?remaining:0n),receiptCount:integer(row.receipt_count,"receipt_count")};
    });
  });
}

async function getReceivableCollectionCoverageHistory(scope: Scope, input: ReceivableCollectionPositionsRequest): Promise<readonly ReceivableCollectionCoverageHistory[]> {
  const requests = collectionPositionRequests(input);
  if (!requests.length) return [];
  return withLockedReceivableCollectionPositions(scope, {requests}, async ({positions,client}) => {
    const first = positions[0];
    if (!first) throw new Error("Missing collection coverage position");
    const requested = positions.map(position => ({sourceId: position.sourceId, customerId: position.customerId,
      collectionRef: position.collectionRef, invoiceId: position.basis === "invoice" ? position.invoiceId : null,
      requiredAmount: position.originalAmount}));
    // All arithmetic and lifetime reconstruction remain in PostgreSQL. The
    // application receives one summary per bounded identity, never its history.
    const result = await client.query(`with requested as (
 select ordinality::integer as request_index,input->>'sourceId' as source_id,input->>'customerId' as customer_id,
 input->>'collectionRef' as collection_ref,input->>'invoiceId' as invoice_id,(input->>'requiredAmount')::numeric as required_amount
 from jsonb_array_elements($4::jsonb) with ordinality as x(input,ordinality)
), scoped as (
 select r.*,s.effective_from,s.effective_through from requested r
 join erp_financials.reporting_book_sources s on s.tenant_id=$1 and s.company_id=$2 and s.book_id=$3 and s.source_id=r.source_id
), payments as materialized (
 select r.request_index,r.invoice_id,p.*,p.metadata->>'collectionRef'=r.collection_ref as in_collection,
   v.effective_date as void_date
 from scoped r join lateral (
   select d.subledger_document_id as payment_id from erp_financials.subledger_documents d
   where d.tenant_id=$1 and d.company_id=$2 and d.source_id=r.source_id and d.party_id=r.customer_id
     and d.document_type='customer_payment' and d.metadata->>'collectionRef'=r.collection_ref
   union
   select a.source_document_id from erp_financials.subledger_applications a
   where a.tenant_id=$1 and a.company_id=$2 and a.source_id=r.source_id
     and a.target_document_id=r.invoice_id and a.application_type='customer_payment_to_invoice'
 ) identity on true
 join erp_financials.subledger_documents p on p.tenant_id=$1 and p.company_id=$2 and p.source_id=r.source_id
   and p.subledger_document_id=identity.payment_id and p.party_id=r.customer_id and p.document_type='customer_payment' and p.currency_code=$5
 left join lateral (
   select (e.payload->>'effectiveDate')::date as effective_date from erp_financials.customer_payment_corrections c
   join erp_financials.financial_lifecycle_events e on e.tenant_id=c.tenant_id and e.company_id=c.company_id and e.source_id=c.source_id and e.event_id=c.lifecycle_event_id
   where c.tenant_id=p.tenant_id and c.company_id=p.company_id and c.source_id=p.source_id and c.payment_id=p.subledger_document_id
 ) v on true
 where (r.effective_from is null or r.effective_from<=p.document_date) and (r.effective_through is null or r.effective_through>=p.document_date)
), applications as materialized (
 select p.request_index,a.application_date,a.applied_amount,a.status,ae.event_id as applied_event_id,ee.event_id as ended_event_id,
   coalesce((ee.payload->>'effectiveDate')::date,(ee.occurred_at at time zone 'UTC')::date) as ended_date,
   (case when a.application_type='customer_payment_to_invoice' and a.target_document_id=p.invoice_id then 1 else 0 end
    -case when p.in_collection then 1 else 0 end) as direction
 from payments p join erp_financials.subledger_applications a on a.tenant_id=p.tenant_id and a.company_id=p.company_id and a.source_id=p.source_id
   and a.source_document_id=p.subledger_document_id and a.currency_code=$5
 left join erp_financials.financial_lifecycle_events ae on ae.tenant_id=a.tenant_id and ae.company_id=a.company_id and ae.source_id=a.source_id and ae.event_id=a.applied_event_id
 left join erp_financials.financial_lifecycle_events ee on ee.tenant_id=a.tenant_id and ee.company_id=a.company_id and ee.source_id=a.source_id and ee.event_id=a.ended_event_id
), deltas as (
 select request_index,document_date as day,original_amount as amount from payments where in_collection
 union all select request_index,void_date,-original_amount from payments where in_collection and void_date is not null
 union all select request_index,application_date,applied_amount*direction from applications where direction<>0
 union all select request_index,ended_date,-applied_amount*direction from applications where direction<>0 and ended_date is not null
), daily as (
 select request_index,day,sum(amount) as amount from deltas group by request_index,day
), running as (
 select request_index,day,sum(amount) over(partition by request_index order by day rows unbounded preceding) as covered from daily
)
select r.request_index,(min(h.day) filter(where r.required_amount>0 and h.covered>=r.required_amount))::text as first_covered_on,
 (exists(select 1 from payments p where p.request_index=r.request_index and (p.status='replaced' or p.status='voided' and p.void_date is null))
  or exists(select 1 from applications a where a.request_index=r.request_index and (a.applied_event_id is null or a.status<>'applied' and a.ended_date is null))) as history_missing
from scoped r left join running h on h.request_index=r.request_index group by r.request_index,r.required_amount order by r.request_index`,
    [scope.tenantId,scope.companyId,scope.bookId,JSON.stringify(requested),first.currencyCode]);
    if (result.rows.length !== positions.length) throw new ErpFinancialsError("missing_document", "Collection history scope changed");
    return positions.map((position,index) => {
      const row = requiredRow(result.rows[index],"collection coverage history");
      if (row.request_index !== index+1) throw new Error("Collection coverage history order mismatch");
      if (row.history_missing) throw new ErpFinancialsError("invalid_input", "Collection cash history requires canonical lifecycle evidence");
      return {sourceId:position.sourceId,customerId:position.customerId,collectionRef:position.collectionRef,currencyCode:position.currencyCode,
        requiredAmount:position.originalAmount,currentCashCoverageAmount:position.cashCoverageAmount,
        firstCoveredOn:optionalDate(row.first_covered_on,"first_covered_on")??null};
    });
  });
}
