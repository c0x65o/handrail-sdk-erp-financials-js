# Pre-v1 SDK Contract

`@handrail/erp-financials/sdk` is the preferred integration surface for new ERP
and FRM applications. It is deliberately larger than a formula library: the SDK
owns financial transactions, optimistic concurrency, idempotency, source
cutovers, cross-source account continuity, invoice state, payment allocation,
reconciliation, pagination, integer money arithmetic, and durable downstream
events.

The root package remains backward compatible. Existing canonical persistence,
QuickBooks adapters, raw report builders, rollup workers, health checks, and
source-scoped APIs continue to be exported. New hosts should begin with the SDK
subpath so provider and compatibility utilities do not become accidental app
dependencies.

## Setup order

1. Run `migratePostgresSchema(...)` through the target version declared by the
   current `POSTGRES_CANONICAL_SCHEMA_MANIFEST` and validate the installed
   manifest before creating application data.
2. Create the canonical company, sources, and company/source bindings.
3. Define one reporting book and its base currency/accounting basis.
4. Bind every provenance source to the book with effective dates.
5. Define the book-owned chart and map source accounts to it.
6. Create the scoped SDK once and inject it into application services.

```ts
import { createErpFinancialsSdk } from "@handrail/erp-financials/sdk";

const sdk = createErpFinancialsSdk({
  database,
  tenantId: "tenant_1",
  companyId: "company_1",
  bookId: "primary_book",
  writeSourceId: "native_erp",
  currencyCode: "USD"
});

await sdk.books.define({
  operation,
  bookId: "primary_book",
  name: "Primary Financial Book",
  baseCurrencyCode: "USD",
  accountingBasis: "accrual"
});

await sdk.books.bindSource({
  operation,
  bookId: "primary_book",
  sourceId: "quickbooks_history",
  sourceRole: "historical",
  effectiveThrough: "2025-12-31"
});

await sdk.books.bindSource({
  operation,
  bookId: "primary_book",
  sourceId: "native_erp",
  sourceRole: "active",
  effectiveFrom: "2026-01-01"
});
```

Historical and active primary-source windows cannot overlap. Adjustment sources
may overlap by design. Reads filter every fact through the effective source
window, which prevents a QuickBooks-to-native cutover from double counting.

## Book identity versus source provenance

A source identifies where a fact originated. A reporting book identifies the
financial ledger users expect to read. They are not interchangeable.

- Every canonical fact retains its source ID and safe provenance reference.
- A book may contain imported history, native activity, and adjustments.
- `reporting_book_accounts` is the authoritative cross-source chart, including
  classification and parent hierarchy.
- A source account maps to one stable book account key. Mapping requires equal
  classifications; incompatible mappings fail closed.
- Unmapped source accounts remain visible under a source-qualified key. They do
  not silently merge with an account from another source.
- Statement and chart read models roll child accounts into their parents. Hosts
  do not implement roll-up arithmetic.

The packaged `ERP_FINANCIALS_SDK_ACCEPTANCE_FIXTURE` demonstrates a nonoverlap
cutover and two source charts mapped onto one book chart.

## Host-facing surface

`createErpFinancialsSdk(...)` returns:

- `commands`: account, journal, fiscal-period, immutable correction, subledger,
  payment, credit, refund, issued-adjustment void/replacement, posted vendor-bill
  void/replacement, deposit, transfer, and write-off commands.
- `books`: book definition, effective source binding, book chart definition,
  source-account mapping, and scope resolution.
- `invoices`: draft create/update/void, atomic issue, issued-invoice void through
  a full credit/application link, and delivery evidence.
- `paymentMatching`: append-only accept/reject decisions and atomic
  accept-and-apply.
- `bankReconciliation`: idempotent feed ingest, exact bank-posting match,
  approved optimistic-concurrency unmatch using persisted match evidence,
  ignore, and independently approved audited unignore/reopen.
- `queries`: cursor-paginated invoices, vendor bills, payments, credits/refunds, general
  ledger, chart of accounts, financial statements, dashboard, A/R and A/P
  aging, bank review, invoice delivery history, customer-payment/application
  detail, write-off detail, exact bill/adjustment detail, and exact
  invoice/vendor-bill/payment/ledger card summaries for host screens.
- `outbox`: leased claim/publish/fail operations.
- `createRuntime(...)`: bounded event delivery and retry routing for a cron,
  queue worker, or serverless timer.

The query layer returns decimal strings and owns SQL, status derivation,
effective-source filtering, account mapping, hierarchy roll-up, aging buckets,
and dashboard signs. Routes and UI components should call these methods rather
than query financial tables.

Matched bank-review rows are a durable command bridge: a row discriminated by
`status: "matched"` includes both `bankReconciliationMatchId` and
`bankReconciliationMatchVersion` from the persisted active match. Hosts use
those values after a reload rather than retaining only the match command
response. Ignored rows can return to `unmatched` only through
`bankReconciliation.unignore` at the current statement-line version. That
correction requires an actor and different approver plus request, correlation,
reason code/detail, and occurrence evidence; stale commands roll back, and an
identical request retry does not append duplicate lifecycle or outbox rows.

The screen summaries have accounting-specific semantics. Invoice outstanding
and overdue totals exclude drafts and voids; unsent draft value is separate;
collected value includes customer-payment applications rather than credits.
Payment summaries return both numerator and denominator for automatic-match
rates, plus unapplied cash and unmatched bank-review counts. General-ledger
summaries return exact cents for debits, credits, and their difference. A host
must format these values, not recompute or round them in route code.

The strict filtered General ledger and versioned reporting-book account
administration contract is documented in
[general-ledger-contract.md](general-ledger-contract.md).

## Invoice lifecycle

Drafts are mutable only through optimistic versioned commands. Issuing a draft
posts the journal, creates the subledger document and immutable lines, links the
draft, records lifecycle evidence, and appends an outbox event in one database
transaction.

Draft mutations are scoped to the configured tenant, company, reporting book and
write source. The caller's command is copied before asynchronous work begins.
Create, update, date-only update, cancellation and issuance retain a checksum of
business content and audit identity. Fresh transport request IDs or timestamps
do not create new writes; changed content, actor, approver or reason conflicts.
Updates and cancellations use the draft ID plus expected version as their
command identity. `invoices.updateDraftDates(...)` changes only the dates and
version, retaining commercial lines and metadata.

Exact creation or update replays return the current draft snapshot, including
its issued/voided status if it subsequently advanced; they do not restore an old
revision. Issuance replays return the original issued document and journal.
Older lifecycle evidence without a command checksum is accepted only when the
remaining stored facts prove an exact match. A missing creation event or an
unprovable replay is rejected, never silently reconstructed.

Commercial lines retain quantity, unit amount, optional exact unit cost (up to
six fractional digits), discount, tax, item, description, service period,
dimensions, account, and final amount. Unit cost is provenance and does not
change customer-facing line arithmetic. The SDK validates
`amount = round(quantity × unitAmount) - discount + tax` using integer arithmetic.

An entirely open issued invoice can be voided automatically. The SDK recreates
its revenue-line provenance as a credit memo, applies that credit to the invoice,
and records an immutable `invoice_voids` link. A partially paid invoice is not
silently voided; the host must choose an explicit remaining-credit/refund
workflow because customer cash has already changed the accounting outcome.

As of 0.3.119 (schema 39 unchanged), `invoices.voidIssued` snapshots the
caller command before awaiting, and new cancellation lifecycle evidence binds
the invoice ID, expected version, cancellation date, memo, effective currency
and accounting basis, actor, approver, reason code and reason detail. An exact
retry returns its original receipt without writes, even after fiscal close.
Transport request/correlation IDs and occurrence time may change. A reused key
with changed bound fields fails with `idempotency_conflict`; it never confirms
cancellation of another invoice. Credit creation, application, cancellation
receipt and outbox are protected by one command savepoint: even if a host catches
a command failure and commits its outer transaction, no partial cancellation
survives. Successful host work outside that savepoint is preserved.

Pre-0.3.119 cancellation receipts lack a complete command identity, including
the originally expected version. They remain immutable and readable through
`queries.getInvoice` and `queries.listInvoiceAudit`. Resubmission of these
unprovable commands returns `unsupported_operation`; callers must reconcile
the recorded cancellation, credit and application through those public reads.
Do not automatically generate another key, rewrite a historical lifecycle, or
infer an original command from the invoice's current version. Inventory saved
pending cancellation retries and implement this recovery path before upgrading
a consumer that uses issued-invoice cancellation. This is an intentional
fail-closed compatibility change, not a data migration. This change does not
add partially paid cancellation, economic replacement, or bank cash refunds.

As of 0.3.120/schema 40, a cancellation's credit application is terminal.
Generic `paymentApplications.unapply` and `void` reject it with
`terminal_state_conflict`. Cancellation does not provide a reopening operation;
a subsequent sale requires a separately reviewed invoice. Ordinary credits and
receipt allocations that do not settle an invoice cancellation remain editable
under their existing lifecycle rules.

A scoped database foreign key requires each `invoice_voids` receipt to reference
an application whose status remains `applied`. The receipt's new
`application_status` column is constrained to that value and is immutable with
the receipt. This is a structural invariant, not a second balance or synchronized
status. Older writers cannot detach the application even if they omit the new
SDK check. Supporting indexes bound the command and foreign-key lookups.

Migration `20261022020000_preserve_invoice_cancellation_applications` adds these
constraints and indexes without repairing financial history. Existing detached
cancellation applications cause the entire migration to roll back. Before
cutover, inventory and reconcile those cases with GL, statements and collection
eligibility, and obtain approval for any production repair. Do not automatically
reapply a credit: it may have been spent elsewhere. Rehearse index build/validation
lock time and disk use on representative volumes. Keep schema 40 protections in
place during application recovery; removing them would re-enable the proved
reopening defect. This does not add a full partial/paid cancellation workflow.

As of 0.3.121 (schema 40 unchanged), cancellation resolves its receivable
account only from the invoice's original accrual postings. It requires one debit
for the full invoice amount in the configured/document currency and rejects
missing or ambiguous evidence. Cash-basis application and unapplication postings
share the invoice transaction ID; their debits must never select the receivable.
A proved pre-fix case cancelled the subledger while leaving the original A/R and
revenue in the accrual GL because a cash reversal's revenue debit sorted first. Native
cancellation also always enforces fiscal periods, including SDK instances using
`legacy_unrestricted` for imports. That import setting previously allowed a new
cancellation to post into a closed period. Exact completed-command replay still
returns the original receipt without reopening the period or posting again.

The corrected lifecycle preserves a received payment as unapplied cash when the
sale is cancelled. Returning that cash requires a separate approved cash-return
command and external movement evidence. Existing cancellations are not reposted
or repaired by upgrading or replaying a command. Before cutover, reconcile each
historical cancellation's original and credit journals by account and dimension,
as well as its subledger application and any separate cash return. Schema 40's
active-application constraint alone does not establish GL correctness. Preserve
historical facts and obtain approval for any necessary compensating SDK entries;
do not silently edit the original credit or its receipt.

As of 0.3.122 (schema 40 unchanged), `sdk.invoices.correctIssued` supplies a
single atomic native invoice correction command. An independent approval (or an
explicit server-configured administrator confirmation for `invoices.correctIssued`)
authorizes a complete release plan: each active application ID/version, its source's
reviewed version before any releases, and an exact nonnegative `reapplyAmount`.
The command rejects incomplete/stale plans, foreign-book/currency/customer
sources, and unsupported applications. Receipts and native credit memos are
supported; imported resources, deposit/write-off applications and other adjustment
kinds require separate verified lifecycle support, not a host-side SQL workaround.

The command unapplies the reviewed allocations, cancels the original invoice
through the terminal cancellation lifecycle, optionally creates and issues a new
SDK draft with the same customer/receivable and correction posting date, and
reapplies only explicitly authorized amounts up to each released allocation. Zero
reapplication preserves unapplied funds/credit. The complete command has one
savepoint, immutable lifecycle completion, payload-bound retry and outbox event.
Cancellation and correction reject independently existing derived credit, draft,
invoice or application keys rather than adopt unrelated accounting instructions.
It enforces fiscal close, including factories configured for legacy imports.
A lost response is recovered with the original key and exact command; the result
is historical completion evidence, not the current financial position.

This is cancellation/replacement, not a partial sale credit or a cash refund.
It never contacts a gateway or returns cash. Native cash returns remain separate
commands with external evidence. Replacement lines and due dates follow the
existing draft contract (including due date on/after the correction date); overdue
contractual due-date preservation needs a separately validated SDK lifecycle/schema
change before a host can offer that option. Original draft URLs and operational
order links must be retained and advanced by a host adapter in the same transaction;
this API does not itself switch BLU links or create an approval screen. Hosts must
obtain the complete reviewed plan using the public bounded read API below; they
must not read SDK tables or infer balances themselves.

As of 0.3.123 (schema 40 unchanged),
`queries.getInvoiceCorrectionReview({sourceId, invoiceId, limit, cursor})` returns
the native invoice header/version, complete active application count and applied
amount, and up to 200 receipt/credit application rows per page. Each row includes
its own version and its source document's initial version, original and open
amounts. Repeated source amounts are not additive. A single SQL statement reads
header, totals, all active source versions and the bounded page; no per-row detail
queries, ledger collection or ended application history is needed.

A scope-bound cursor includes the review token. Changes to the invoice or an
active receipt/credit, even use of that source on another invoice, invalidate the
next page with `optimistic_concurrency_conflict`; restart the review rather than
mix snapshots. The token detects changed evidence, not user authorization or a
reservation of funds. `correctIssued` revalidates every version and the complete
release plan under its write lock. The reader rejects cancelled invoices, foreign
native book evidence, and unsupported active sources such as write-offs; it never
silently omits them to manufacture an executable partial plan. BLU still needs the
approval, stable-link and UI integration, including paginated review consumption
without routine whole-history collection.

Invoice list status is derived as draft, open, sent, overdue, partial, paid, or
voided. `queries.listInvoiceDeliveries(...)` returns append-only event identity,
status, channel, recipient reference, occurrence time, and lifecycle reference.

`commands.invoices.correctDates(...)` restates an issued native invoice's
`documentDate` and `dueDate`, with an expected document version, idempotency key,
and approved operation context. Both the previous and new recognition periods
must permit posting, even under `legacy_unrestricted`. An independent approver
is required by default; the guarded administrator policy may explicitly enable
`invoices.correctDates`. Imported/provider-owned and voided invoices are rejected.

The command retains the invoice ID, original transaction, commercial lines,
receipt records, application identities, amounts, and cash-basis recognition.
It posts an accrual reversal on the previous document date and an equal
replacement on the corrected date. A due-date-only correction posts no journal.
This is a restatement, not a sale cancellation, cash refund, or current-period
adjustment. Date-based reports use the corrected dates; immutable lifecycle
evidence retains the prior dates and both compensation transaction IDs. It does
not provide a separate “what was known then” report.

Database guards allow only the evidenced date/version transition and check
compensation dates, amounts, accounts, dimensions, lifecycle and outbox
completeness at commit. Partial work cannot commit when a caller catches a
mid-command error inside its own transaction. Unpaid, partially paid and paid
invoices share this lifecycle. Replays return the original correction result
after later corrections or fiscal closure; changed business content, actor,
approver or reason conflicts. Issuance retries still compare the original
issuance dates, rather than treating a later restatement as changed input.

## Manual journal provenance and retries

Manual journal commands may include `origin: { module, reference? }` for the
operational source label and stable reference. The module is bounded to 80
characters and reference to 256. Origin is part of the immutable posting checksum
and is returned as `sourceProvenance.origin` by journal reads. It never selects
the tenant, source, accounts, or accounting treatment. Omitted origin preserves
the checksum contract for existing callers.

Repeating an identical journal command may use fresh transport request IDs,
correlation IDs, and occurrence timestamps. The SDK returns the original posting
and lifecycle event without rewriting its audit. Changed actor, approver,
business reason, origin, or accounting content conflicts with the original
command key.

## Credits and refunds

`queries.listAdjustments(...)` is the canonical credit/refund register and
`queries.getAdjustment(...)` returns the exact document lines, ledger postings,
applications, and void/replacement links. Hosts must not create a parallel
adjustment table or recompute these states from route-local data.

Issued adjustments can be ended through `commands.adjustments.voidIssued(...)`
or replaced through `commands.adjustments.replaceIssued(...)`. Typed
`commands.credits` and `commands.refunds` aliases expose the same operations.
Both workflows require independent approval, use optimistic concurrency and
idempotency, post a compensating adjustment journal, set the original canonical
document to voided, and record immutable journal/lifecycle links in one database
transaction. Replacement additionally issues the same adjustment type for the
same customer. Credits with an active or partial application fail closed until
the application is unapplied; refunds and unapplied credits never require a
host-local accounting ledger. Runtime consumers can handle issue, void, and
replacement events through `onAdjustmentChanged`.

As of 0.3.70, `commands.customerPayments.previewReturnCash(...)` validates a proposed native receipt cash return before a host submits money movement to a provider. Pass receipt/customer IDs, expected receipt version, accounting date, exact amount, refund/void kind and explicit versioned allocation releases. It returns the normalized release plan, current receipt version/unused credit and the projected remaining returnable amount. It writes no accounting facts, approvals, command receipts or outbox events and does not require a provider return ID or fabricated approver. Hosts must authorize the read and independently persist real consent.

Preflight and posting share receipt ownership/currency, version, date/fiscal-period, available credit, return/void amount, original-journal account eligibility and application release validation. Selected applications also validate their cash-basis reversal/residual projections and eligible accounts. Preflight uses scoped transaction locks while checking, but **does not reserve funds or guarantee future posting**. Revalidate at dispatch; posting always rechecks. A provider result can arrive after a version/permission/period change, so preserve confirmed evidence and recover accounting without resubmitting the provider request. Preflight is not an idempotency replay endpoint and does not check a future provider reference or command key; final posting checks those identities and its complete lifecycle/approval constraints.

Native receipt cash returns use `commands.customerPayments.returnCash(...)`.
This command is separate from sale cancellation or credit issuance: the invoice
remains valid and becomes collectible again when a receipt application is
released. An authorization release with no captured cash must not call it.
The command requires the receipt/customer identities, receipt version, accounting
date, positive decimal amount, refund/void kind, stable external return reference,
and an explicit application release plan containing application IDs, versions,
and amounts. A captured-cash void returns the entire unrefunded receipt.

The SDK consumes unused receipt credit first. Any remaining amount must exactly
match the release plan. It derives the cash and receivable accounts from the
original native receipt journal, releases the selected invoice applications,
reapplies their residual amounts, posts the cash return, and settles the refund
against the receipt in one transaction. Fiscal posting controls and independent
approval apply. Concurrent retries with identical command content return the
original result; changed content under the same key fails. Hosts must namespace
the external return reference with provider/account identity so one provider
return cannot be recorded twice under different command keys.

Receipt-return settlements and their refund documents cannot be voided through
generic application or adjustment commands. Imported/provider-owned receipts
are not supported by this native command. The host must retain uncertain gateway
outcomes and retry accounting with the same confirmed return identity; this SDK
command never invokes a payment provider. Current payment detail applications
include `customer_payment_to_refund`; consumers must distinguish returned cash
from invoice collections rather than treating every application as a sale.

Payment detail, payment lists, and the customer payment register expose
`returnedAmount` and `retainedAmount`. A fully returned receipt has status
`returned`; its refund settlements do not count as matched invoice applications.
Payment summary and register totals include the same amounts for the selected
receipt-date cohort, using its current position. They are not a cash-flow report
of refunds by refund date; use the general ledger for period cash movement.
The original `amount`/`receivedAmount` remains the gross recorded receipt amount.

Posting-date validation holds a shared transaction lock on the fiscal scope.
Closing, reopening, defining periods, and changing the posting lock take the
exclusive lock for that scope. This includes insertion of the first posting
lock, where there is no existing control row to lock. Hosts must finish the
posting transaction promptly and must not perform network calls while holding it.

## Matching and applications

`paymentMatching.acceptAndApply(...)` is the normal path from a suggested match
to financial allocation. It locks the candidate, appends the decision, changes
candidate state, validates document type/party/currency/amount/version, inserts
the canonical subledger application, updates both open balances through database
triggers, records lifecycle evidence, and appends the outbox event atomically.

`queries.getCustomerPayment(...)`, `queries.listPaymentApplications(...)`, and
`queries.getPaymentApplication(...)` are the canonical reload paths. Customer
payment recording accepts bounded bank-match/deposit references. Application
reads return the exact amount, source/target documents, status/version, terminal
lifecycle links, and bounded match decision evidence.

Bill-payment hosts use the bill-specific `queries.listBillPayments(...)` read.
It applies optional vendor, inclusive period, `scheduled | cleared | voided`,
and `ach | card | check` filters before cursor pagination. The generic
`listPayments(...)` remains available for application-balance views.
`queries.getBillPayment(...)` returns method and separate reference, funding and
payable account identities plus exact posting IDs/amounts after clearing,
ordered covered-bill applications, optimistic lifecycle/document versions, and
scheduled, cleared, posted, voided, and reversal evidence. The bounded
`queries.getBillPaymentSummary(...)` computes register KPIs from the complete
filtered canonical set; hosts must not sum a page of register rows.

`commands.billPayments.recordAndApply(...)` is the normal immediate-payment
boundary. One payload-bound idempotency key covers the instruction, payment
journal, ordered applications, balance transitions, lifecycle events, and
outbox events in one transaction. Each allocation carries a bill ID, exact
decimal amount, and expected bill version. The command rejects duplicates,
cross-company/vendor/currency documents, ineligible balances, stale versions,
and allocation totals that do not equal the payment total. A retry returns
`already_cleared` without duplicating any fact. As of 0.3.112, both immediate
payment and scheduled-clear retries return the original completion receipt even
when a later bill correction has unapplied or reassigned its allocations. Receipt
payment balance/version and application versions describe the completed clear,
not current positions; use query APIs for current balances and application state.
Replay validates retained instruction, journal, book, document and application
evidence without invoking posting or application writers. Missing or inconsistent
evidence fails closed. Generic application-command retries still reject an ended
application. This does not authorize retrying a voided cash payment as cleared.

`commands.vendorBills.setPaymentHold(...)` owns the current payment hold on a
native, outstanding bill. The command requires operation evidence, the canonical
bill version, a payload-bound idempotency key, and a nonblank reason when placing
a hold. Hold and release increment that same version, without a journal or balance
change. A retry returns the original result with `already_changed`, including after
a later release; use `getOperationalDocumentSummary` for current state. Changed
business payloads or actor/approval evidence under the same key are rejected.
Transport request/correlation/time changes alone do not defeat a safe retry.

`commands.vendorBills.retirePaymentHoldAttempt({command, operation})` resolves an
uncertain hold/release using the exact original command and same-actor cancellation
evidence. It returns the original receipt plus current state when accepted, or
permanently fences the original key when unaccepted. Cancellation does not change
a hold or balance. Current revision, settlement or fiscal close does not prevent
recovery; original native posting-book/currency provenance remains required.

The host must authorize the actor before invoking this trusted-server command.
It does not infer role permissions or introduce an independent-approver policy.
Company, tenant, native source, original posting book and currency are checked.
Provider-owned bills require provider controls. Fiscal locks do not block this
non-posting control; payment commands retain their posting-date checks.

A held bill rejects new schedules, clearing an existing schedule, immediate
record-and-apply, and generic `bill_payment_to_bill` applications. PostgreSQL
also rejects direct application inserts against held bills. The bill row lock
serializes hold/payment races; lifecycle, current state and outbox commit together,
including when a host catches an intermediate command failure. Release does not
make an old expected bill version valid again: cancel an old unposted schedule
and revalidate its replacement using the current canonical version.

Holds do not prevent corrective unapplication or payment reversal. An exact retry
of a completed payment creates no new money and remains valid after a hold.
`listVendorBills`, `getVendorBill`, and operational summary/detail reads expose
`paymentHold` and `paymentHoldReason` as **current** controls, even with a historical
balance `asOfDate`. Existing balance/status meanings remain unchanged; a hold is
not another paid/open status. Optional type fields preserve source compatibility
for existing consumer fixtures; schema-32 real reads always supply the fields.
A terminal bill may retain historical hold state, but its terminal status and zero
open balance take precedence; placing/releasing holds requires an outstanding bill.

Schema 32 adds false/null defaults to existing documents and installs guarded
hold transitions and application enforcement. Pending correction previews
that hash complete document rows must be regenerated after this schema upgrade;
posted correction results and stored transaction/posting evidence are preserved. It does not infer or migrate host
hold records: hosts must reconcile and explicitly import their holds before
switching payment commands. Do not remove a host hold check before completing
that bounded cutover. The SDK hold release and its version are the sole authority
after cutover, rather than an indefinitely synchronized host flag.

As of 0.3.79, immediate-payment, schedule and clear retries compare business
payload and actor/approver/reason evidence, while allowing fresh request IDs,
correlation IDs and occurrence timestamps. Completed replay uses the stored original
operation when reconstructing its result; it never rewrites the original audit or
posts another payment. Changing semantic authorization returns an idempotency
conflict. Transport metadata must not force a host to keep an independent payment
replay authority. Cancellation and correction commands retain their own documented
replay rules and are not covered by this specific change.

For future payments, `commands.billPayments.schedule(...)` persists a
non-posting instruction and immutable allocation/provenance evidence.
`commands.billPayments.clear(...)` optimistically posts and applies that exact
instruction atomically; `cancel(...)` ends an unposted schedule. Both lifecycle
commands are replay-safe and reject a different command after state advances.

`commands.billPayments.void(...)` (also exposed as `voidIssued` and
`voidPosted`) is the correction boundary for an erroneous posted payment. It
requires independent approval, an expected document version, and an
idempotency key; it posts a compensating journal and marks the payment voided in
the same database transaction. Applied or partially applied payments fail
closed until their active applications are ended through
`commands.paymentApplications.unapply(...)` or `.void(...)`. For canonical
cleared disbursements, `commands.billPayments.voidAndUnapply(...)` is the
supported compensation boundary: it ends every active application, restores
the vendor-bill balances, posts the reversal, marks the payment/disbursement
voided, and emits lifecycle/outbox evidence in one transaction. Retrying the
same completed command returns `already_voided` and never posts a second
reversal.

## Recurring financial occurrence planning

`sdk.recurring` provides deterministic, non-posting recurrence planning for
monthly, quarterly, and annual instructions. The calendar anchor is preserved
across short months and leap years, and every occurrence receives a stable ID
and idempotency key. Hosts checkpoint the last materialized date and request a
bounded catch-up window; the planner fails closed rather than silently dropping
an occurrence when that window exceeds its limit.

The typed materializers deliberately preserve the canonical write boundaries:

- `recurring.invoiceDraft(...)` produces a replay-safe `invoices.createDraft`
  command with deterministic document dates, terms, and recurrence provenance.
- `recurring.billPayment(...)` produces a replay-safe
  `commands.billPayments.schedule` command only after the host supplies the
  exact current bill IDs, amounts, and optimistic versions. Recurrence never
  guesses which payable balance to reduce.
- `recurring.cashDisbursement(...)` produces a balanced journal command for
  approved non-A/P cash movement such as a shareholder distribution. The host
  must choose the debit account; the package does not infer that a distribution
  is an expense or turn a shareholder into a vendor.

These helpers do not register a cron or queue, persist host recurrence settings,
approve a payment, clear a scheduled bill payment, or transmit ACH/card/check
instructions. The host owns template storage, authorization, scheduler
registration, bill resolution, occurrence checkpointing, and execution of the
materialized canonical command. Bank/payment-provider transmission remains a
separate integration boundary.

Write-offs accept bounded reason, related-invoice, balance-account, and
write-off-account provenance. `queries.listWriteOffs(...)` and
`queries.getWriteOff(...)` expose that provenance with durable actor/approver
evidence and correction links. `commands.writeOffs.voidIssued(...)` and
`replaceIssued(...)` require independent approval and use compensating journals;
posted write-offs are never edited or deleted directly. Refund detail likewise
returns its bounded related-invoice, method, lifecycle reference, and durable
operation provenance.

Use `commands.writeOffs.settleInvoice(...)` when a receivable write-off must
reduce a canonical invoice balance. The command posts an open write-off and
immediately applies it through `write_off_to_invoice` in one transaction. It
requires the invoice's optimistic version, validates company/customer/currency,
caps the amount to both available balances, and returns the updated canonical
invoice status/version. A stable idempotency replay returns `already_settled`.
Hosts must not call `writeOffs.record(...)` and then update invoice state
themselves.

Application apply uses `applicationDate` for fiscal-period and posting-lock
enforcement. Application unapply and void require an explicit `effectiveDate`
and apply the same lock policy before lifecycle, outbox, or balance changes.
Identical completed retries remain no-op replays even if that date is later
locked.

`payment_applications` remains only for compatibility with the older canonical
contract. New native writes use `subledger_applications`; hosts must not write
both representations.

## Currency contract

Pre-v1 is intentionally single-currency per reporting book. Every command and
read must use the configured base currency. A different currency produces the
stable `currency_not_supported` error before posting.

This is safer than accepting a foreign currency without owning exchange-rate
sources, functional/reporting currency, realized gains and losses, revaluation,
and settlement rounding. Multi-currency support requires a later complete
contract and migration; it must not be approximated in a host route.

## Errors and retries

Catch `ErpFinancialsError` and branch on `code`, never message text. Codes cover
invalid input, missing scoped entities, currency, fiscal locks, idempotency,
optimistic concurrency, unbalanced posting, reconciliation conflicts, terminal
state, and unsupported operations. `retryable` is true only when retry/refetch is
appropriate. `details` contains bounded scalar context safe for a host API after
the host applies authorization.

All financial mutations still require a `FinancialOperationContext`. The host
owns authorization policy; the SDK owns durable actor, approver, request,
correlation, reason, and event evidence.

## Runtime and rollups

Ledger and hierarchy mutations enqueue a transactional outbox event alongside
the financial write. Invoice, match, application, and reconciliation workflows
do the same. `createRuntime(...)` handles leases, bounded batches, publication,
failure recording, and exponential retry dates. The host supplies only its
domain handlers, such as invoking packaged source rollup/snapshot workers and
invalidating a UI cache.

As of 0.3.74, `createFinancialOutboxService({ database, tenantId, companyId,
bookId, sourceId })` optionally restricts claim, publish and fail operations to
one source. Use it with `createFinancialRuntime({ outbox, handlers })` when a
host owns only that source's effects. Omitting `sourceId` preserves existing
company/book delivery. This is a source partition, not a subscription system:
consumers with overlapping scopes still compete for the same events. Route all
required effects through one delivery owner and make host effects idempotent;
a process can stop after an effect commits and before publication succeeds.

Runtime registration and cadence remain host/platform operations. Source code
does not claim that a cron or queue has been deployed.

## Compatibility and readiness boundary

The schema version and migration target in the current
`POSTGRES_CANONICAL_SCHEMA_MANIFEST` are the pre-v1 database foundation. Before
publishing 1.0, prove this exact SDK surface in the first ERP application and
treat feedback as contract feedback, not a reason to add host-local SQL.
Breaking changes remain possible before 1.0.

Repository-owned behavior is ready for that first adoption. Production use still
requires owner-approved database migration, runtime registration, deployment,
backups, least-privilege roles, and any provider credentials/data access listed
in the production blocker matrix.

### Invoice detail snapshot and creation evidence

`queries.getInvoice` and bounded `queries.getInvoicesByIds` use the same SQL
projection. The invoice header, current balance/version/status, commercial lines
and creation evidence are read in one PostgreSQL statement snapshot. Concurrent
edits cannot combine one revision's total with another revision's lines.

Invoice details expose storage `createdAt` / `updatedAt`, `idempotencyKey`, and the
original `transactionId` for posted documents. `creationLifecycle` is the actual
creation/posting event's actor, approver (if present), request, reason and event ID.
It is absent when there is no recorded creation event; consumers must not invent
an actor from a date or ID. It does not identify the actor responsible for every
later balance/application change. A draft has no posted transaction ID.

These are current invoice snapshots. As before, `asOfDate` determines overdue
classification; it does not reconstruct historical balances. Use customer
statements and the historical accounting reports for period-end amounts.

Customer-payment detail reads also expose canonical storage timestamps,
`idempotencyKey` and optional `creationLifecycle`. These identify the receipt's
original recorded actor without borrowing an application event or host payment
record. They do not identify the actor who last changed the receipt balance.
Invoice detail lines expose the canonical account number when present, so hosts
need not recover it by joining their retired financial account tables.

### Invoice audit pages

`queries.listInvoiceAudit(invoiceId, {limit, cursor})` returns immutable lifecycle
records for an invoice, its originating draft, original posting, direct invoice
corrections/delivery/cancellation and applications into that invoice, including
ended applications. Both the issued document ID and its original draft ID can
identify the history. Receipt posting and unrelated invoice events are excluded;
receipt allocation is not a new cash collection. Related command payloads retain
receipt, reversal and replacement references for drilldown.

Results are scoped to the tenant/company/reporting book, its source bindings and
currency. Limits are 1–200. Cursors are opaque, bound to the complete scope and
requested invoice ID, and preserve PostgreSQL microsecond recorded timestamps.
Ordering is by recorded time and event ID descending; occurred time remains the
original business-operation timestamp. Pages are a live append-only view, not a
frozen export snapshot: refresh the first page to see newly recorded events.
Missing or out-of-book invoices fail with `missing_document`; cursor reuse across
invoices/scopes fails with `invalid_input`. Version 30 adds read indexes only;
normal schema migration and schema health checks still apply.


### Receipt detail snapshot and application paging (0.3.67)

`queries.getCustomerPayment(paymentId, { limit?, cursor? })` reads the receipt
header, current balances/counts, original lifecycle evidence and the selected
application page in one PostgreSQL statement. A concurrent allocation cannot
mix a prior balance with later application evidence. Receipt visibility honors
the reporting source binding's effective dates and the book currency.

`applications` is a bounded page (default100, range1–200), ordered by application
date and ID descending. Pass `applicationsNextCursor`, when present, back to
`getCustomerPayment` for that same receipt/book/company. Cursors are scoped to
the receipt, tenant, company and book. Monetary JSON fields are serialized as
strings to preserve precision. Header balances and `matchedApplicationCount`
cover the whole receipt, not merely the application page. Do not infer totals
from page length. This replaces the previous hidden101-row cutoff.

Each call is a consistent live snapshot; multiple pages are not a frozen export.
Refresh the first page after a command. Existing one-argument calls remain valid,
but consumers needing full application history must follow the explicit cursor
or use a bounded application list, never assume the embedded array is complete.


### Atomic invoice receipt collection (0.3.68)

`commands.customerPayments.recordAndApply` records a **new** customer cash receipt and applies its full amount (or an explicit positive `applicationAmount` as of 0.3.69) to one issued invoice in one transaction. The application must not exceed either the receipt amount or the invoice outstanding balance; excess receipt cash remains unapplied customer credit. An omitted application amount retains the previous full-receipt behavior and checksum. Its input extends `RecordCustomerPaymentInput` with `invoiceId` and `expectedInvoiceVersion`. Use `customerPayments.record` plus explicit application commands for intentionally unapplied cash or existing receipts; the composite operation does not adopt a receipt previously recorded independently under the same key.

The result identifies the receipt, invoice, application, cash journal and completion lifecycle event; `amount` is the entire cash receipt, including any portion left unapplied. It is an immutable command receipt, not a current balance snapshot. Query current receipt/invoice state separately. A retry with the same business payload, expected invoice version, actor and reason returns the original identifiers, including after later allocation/correction activity. Request/correlation IDs and retry timestamps may change. Changed target, receipt/application amount, business date, expected version, accounts, actor or reason under the same key is a conflict. Scope includes tenant/company/source and the configured book/currency.

The SDK locks in the same order as receipt application/correction, creates the cash journals, applies the receipt, and records the composite checksum/completion event in the same PostgreSQL transaction. An excessive application amount, stale versions, different customers, missing targets, closed periods or application failures leave no new cash receipt, posting, lifecycle event or outbox event. Concurrent collections on the same invoice use SDK document versions and cannot both consume the same outstanding amount. Existing separately recorded keys fail closed; migration must explicitly reconcile them rather than treating them as composite retries.

This operation currently shares the source-level receipt-correction transaction lock. It is a correctness boundary, not evidence of throughput at scale; measure contention with the intended workload before making capacity claims.

## Collection positions (0.3.71)

Native `customerPayments.record` and `recordAndApply` accept an optional immutable
`collectionRef` (1–512 characters). It identifies the host's operational order or
collection group; it stores no amount or status. Omitting it preserves existing
command/replay behavior. Schema31 indexes the reference and prevents reassignment.
Historical receipts need an explicit verified migration association; neither reads
nor normal startup infer a group from memos, customer names or document numbers.

`queries.getReceivableCollectionPosition({sourceId, customerId, collectionRef,
invoiceId})` returns current SDK invoice/open amounts, linked unused cash, current
cash applications to the invoice, cash coverage and remaining collection capacity.
A draft ID follows its issued invoice. Before a draft exists, provide
`unbilledAmount` instead of `invoiceId`: this is the host's commercial amount,
not posted revenue or a ledger balance. An absent or differently scoped invoice
fails; it never falls back to the commercial amount. Voided invoices have zero
collection capacity. Credit allocations reduce the invoice balance but do not
become cash toward a deposit. Receipts applied elsewhere cease covering this
group; receipts from another group applied to this invoice count once here.

Financial facts are aggregated in PostgreSQL from one statement snapshot. No
application history or receipt detail fanout is returned. This is a current
collection projection, not an as-of report, approval or cash reservation. Hosts
must still serialize operational claims, reject pending provider/accounting
outcomes, recheck at dispatch, and preserve confirmed provider evidence if the
financial state changes during provider latency. Source/customer/book/currency
boundaries are enforced. Imported deposits and other non-customer-payment cash
instruments are not included in this receipt-specific cash-coverage measure.

### Bounded collection batches (0.3.72)

`queries.getReceivableCollectionPositions({requests})` accepts at most 200
collection-position requests and returns one result per request in input order.
The single-position API delegates to the same implementation. All financial
positions share one PostgreSQL statement snapshot; the batch does not perform
per-request SDK calls or return application histories. Requests are restricted
to their source, customer, company, book, currency and source effective dates.
Duplicate `(sourceId, customerId, collectionRef)` identities, invalid inputs or
a missing/mismatched invoice reject the whole batch; empty input returns `[]`.

Use this with a bounded page of operational identities. It is not an unbounded
ledger scan, a lock/reservation, proof of historical ownership, or a replacement
for operational authorization and provider/accounting uncertainty checks. Do not
treat overlapping invoice/group views as independent permission to collect cash.
Hosts still own their operational claim serialization and must remove financial
write/read fallbacks. No schema change is required beyond schema31.

### Transactional collection guards (0.3.73)

`queries.withLockedReceivableCollectionPositions({requests}, async
({positions, client}) => result)` checks 1–200 positions and executes an operational
callback while their financial inputs remain protected. Use the supplied public
`PostgresQueryClient` for the operational write, or supply an SDK transaction
runner that reuses the host's already-open physical transaction. Locks survive
the callback until that outer transaction ends. Errors propagate and roll back
the SDK-owned transaction; an outer host transaction must propagate errors too.

Acquire all required host locks first and validate host identity/revision before
calling the guard. The host still owns authorization, deposit/release policy,
provider uncertainty checks and audit of its operational decision. The callback
must perform only bounded operational writes: no SDK financial/configuration
commands, network/provider calls or long-running work. Returning a position and
then acting after the transaction commits is not protected. This API neither
reserves cash nor persists a second accounting approval/balance.

Guards require one explicit READ COMMITTED transaction. Autocommit transaction
runners and repeatable-read/serializable isolation are rejected: a snapshot from
before waiting for a financial writer must not authorize a later operational
release. Financial amounts are read again after acquiring the locks. Returned
positions are frozen. Invalid identities/scopes or callback errors never produce
a partial successful batch. Ordinary collection queries remain nonlocking.

Guards take shared `payment-correction` source advisory locks, followed by shared
reporting-book and source-binding row locks. Native receipt creation, invoice
draft/issuance/void mutations, application/unapply, date corrections and cash returns use
the same source protocol exclusively before document/fiscal locks. Managed
QuickBooks imports and explicit external-source resets use that protocol. Arbitrary direct SQL/storage
mutations outside the SDK protocol are not supported by this guarantee. Hosts
combining sources in one transaction must acquire source locks in sorted order.

Multiple guards may coexist; financial writers wait for their transactions to
end. This source-wide exclusion is an explicit contention tradeoff of the
existing correction protocol. Keep operational batches/transactions short and
measure throughput and lock waits for the host workload. It does not establish
million-entry performance by itself.


### Historical cash-coverage summaries (0.3.75)

`queries.getReceivableCollectionCoverageHistory({requests})` uses the same bounded
1–200 identities (empty input returns `[]`) and returns `requiredAmount`,
`currentCashCoverageAmount` and `firstCoveredOn` for each identity. It reconstructs
cash coverage by effective date from receipt creation, cash applications and
unapply/void/return history. It adds unused receipts in the collection and cash
allocated to its invoice, without counting internal applications twice. Credits
and write-offs never supply cash. Missing canonical lifecycle evidence rejects
rather than inventing historical payment facts.

The target is the **current** invoice/draft amount or the explicitly supplied
unbilled commercial amount. `firstCoveredOn` is the first effective day cash
coverage reached that target; it is null if the positive target was never reached
(or the target is zero). It is not the first delivery time of an outbox event, a
statement of historical commercial prices, or proof that cash remains available.
Later refunds can leave a historical date with insufficient current coverage.
Hosts must separately validate current eligibility and the provenance of any
commercial/tax date. Backdated financial corrections can change the historical
summary; an already issued external tax request must retain its frozen identity
and go through reconciliation rather than silently replacing that request.

SQL aggregates the bounded groups; no receipt/application lists are returned.
The query uses the collection guard internally so current and historical amounts
share one protected READ COMMITTED transaction. When combined with a host write,
use a runner bound to the host transaction, acquire host locks first, and keep all
network calls outside that transaction. This API makes no million-entry latency
claim; measure the actual groups and application history before launch.


## Current document summary (0.3.76)

`queries.getOperationalDocumentSummary(documentId, sourceId?)` returns the existing
`OperationalDocumentListItem` for one document in the reporting book, including
source, party, currency, current amounts, lifecycle status and version. It uses
the scoped document register without loading lines or application history.
Missing or out-of-book identities reject. Command adapters should supply their
write source to prevent resolution through another source in a shared book.
This is current state, including
subsequent effective payments and corrections, not an as-of financial report.
Use the returned version with the corresponding command's optimistic checks;
this read does not reserve the document or authorize a later write. Use the
paginated register for collections, not a loop of summary/detail reads.

In 0.3.76, bill-payment lifecycle replay began comparing `operation.occurredAt`
as a normalized instant so a timestamp without fractional seconds could replay
its stored PostgreSQL timestamp. Version 0.3.79 additionally allows fresh
transport metadata for immediate-payment, schedule and clear retries, as
described above. Cancellation and correction commands retain their own rules.

The operational document register and subledger issuance/application replay
lookups preserve SQL DATE values as strings. Those paths do not convert a local
midnight JavaScript Date to UTC, which could otherwise shift a business date.
The summary/payment replay regression is also executed under Pacific/Auckland;
this is scoped evidence, not certification of every SDK date reader.


## Civil-date transport (0.3.77)

Financial dates are SQL DATE values, not instants. Command loaders and public
read projections return those values as text before the database driver can
interpret them as local-midnight JavaScript Dates. Timestamp evidence remains
an instant. The SDK does not install or change a global PostgreSQL type parser.

This corrects fiscal-period replay and close/lock boundaries, invoice draft and
correction lifecycles, cash-return chronology, scheduled payable clearing,
commercial service periods, bank-line replay, and date-based report cursors.
SQL filtering and cursor comparisons retain native DATE types; only result
projections become text. An exact posting-lock date is inclusive: a journal on
that date must be rejected without accounting changes.

Imported customer-payment correction continues using its existing raw evidence
representation for checksum validation. It reads civil dates separately from
the same locked records for fiscal checks. This release does not silently
regenerate evidence, change historical dates, or reconcile previously stored
incorrect data. Changing a deployment's timezone or database parser still
requires verifying existing imported evidence compatibility; historical
correction evidence is not assumed portable merely because current dates read
correctly. Invalidated in-flight correction previews must be obtained again.

Regression coverage includes real PostgreSQL tests with a non-UTC process
timezone, inclusive lock rejection with full database-state equality, exact
invoice and receipt dates, date-cursor traversal without missing/duplicate
records, bank ingest replay, service periods, scheduled payment clear/retry,
and cash-return chronology. Run the disposable suite under both UTC and
Pacific/Auckland when changing DATE projections. This is code/test evidence,
not validation of a deployed database or historical accounting accuracy.

## Posting-lock version correction (0.3.79)

Updating or clearing an existing posting lock now accepts its current nonzero
expected version. The SQL previously excluded the candidate row before conflict
handling, so every such update failed even with the correct version. Missing
records with nonzero versions and stale versions still fail without committing
accounting or lifecycle changes through the standard transaction runner.

## Vendor bill account policy (0.3.80)

`commands.vendorBills.create` accepts optional `accountPolicy` with nonempty
`expenseClassifications` and `payableClassifications` arrays of supported account
classifications. The SDK checks the canonical accounts under the same transaction
and hierarchy locks used by posting and account changes, before writing any
journal or lifecycle facts. Hosts can specify their allowed bill account roles
without validating a second chart of accounts. Inactive and non-posting account
checks and fiscal checks still apply independently.

The normalized policy is retained in the document's immutable metadata and must
match on issuance replay. Array ordering and duplicate classifications do not
change the policy. Input is snapshotted before asynchronous work. Replaying a
completed issuance does not reassess it against later account classifications or
reopen a period; it validates the original command and returns current state.
Omitting the policy preserves the pre-0.3.80 behavior for existing consumers.
Adding a policy to an old issuance is a different payload and fails idempotency
validation; upgrades must reconcile historical commands rather than use new
keys to issue duplicate bills.

## Scoped operational account lookup (0.3.81)

`queries.getOperationalAccount({ sourceId, accountId, asOfDate })` returns one
canonical source account definition: identity, source identity, optional account
number, name, type, classification and active flag. The account ID is the SDK
canonical identity accepted by posting commands' `{ accountId }` reference; it
is not a reporting book key or a host navigation ID.

The query requires the account's source to belong to the configured tenant,
company and reporting book on `asOfDate`. Missing or out-of-scope accounts return
`missing_account`. Inactive accounts remain readable with `active: false`.
It does not read ledger postings, compute balances, collect the chart, or grant
posting authorization. Commands still validate current account eligibility and
classification policy under their posting locks. Applications can use this
lookup to capture operational request labels without caching accounting state.

## Vendor bill audit (0.3.82, schema 33)

`queries.listVendorBillAudit(billId, { limit, cursor })` returns immutable lifecycle
evidence for the scoped bill: issuance and hold events, incoming applications
(including unapplied/voided history), scheduled/cancelled/cleared payment
instructions allocating to the bill, and their related payment posting events.
It excludes unrelated bills and payments. Corrections recorded against the
original bill are included; following replacement-document history is a separate
navigation operation. The query does not infer historical events for imported
provider facts that have no SDK lifecycle evidence.

Pages contain at most 200 events and use descending recorded timestamp/event ID
boundaries with PostgreSQL microseconds preserved. Cursors are bound to tenant,
company, book, bill and read kind. Empty existing-bill history is distinct from
`missing_document`; unavailable API must not be replaced with host audit history.

Schema 33 adds a GIN allocation-containment index for bill-specific scheduled
payment lookup. It rewrites no financial rows. Index creation runs inside the
normal migration transaction and takes PostgreSQL's index-build lock; schedule
and measure it as part of a bounded cutover on large deployments. Schema
validation checks index access method as well as columns. Index usability tests
are not million-entry latency or contention measurements.


## Fiscal lifecycle retries (0.3.84)

`beginClose`, `close`, and `reopen` replay the original transition only when its
prior `expectedVersion`, actor, approver, reason code/detail, and business
payload match immutable lifecycle evidence. Close additionally binds every
close-evidence field, including reconciliation-reference order and the evidence
checksum. `postingMaxUpdatedAt` compares as an instant, consistent with the
public checksum. A valid but different evidence checksum is a conflict, not
proof that an existing close used that evidence.

Under independent approval, request ID, correlation ID, and occurrence time may
change on retry. The original lifecycle event and audit metadata are retained;
retries do not insert events or advance period/book-control versions. An exact
reopen retry returns its existing `reopened` result. Replays from an older
close/reopen cycle fail even if the period has returned to the same status.
Administrator-direct actions still require the existing exact-command
confirmation and guard; this retry contract does not relax that approval gate.

These commands snapshot caller input before awaiting transaction locks. Replays
serialize with fiscal mutations and posting through the existing fiscal scope
lock. A matching current status by itself is no longer sufficient for success.
Consumers that used `beginClose` or `close` as an unconditional "ensure status"
operation must instead read the current period and submit the authorized
transition with its original version and semantic intent.

This fixes replay correctness; it does not certify host close checklists,
reconciliation references, trial-balance snapshot contents, or migration of
legacy host evidence. The SDK still validates the supplied evidence checksum;
BLU must replace legacy close-readiness and evidence construction separately.

## Fiscal ledger diagnostics and close validation (0.3.85)

`queries.getFiscalCloseDiagnostics(sourceId, fiscalPeriodId)` returns current
source-wide posting and draft counts for an accessible fiscal period. The book
must exist in the calling tenant/company and be bound to the source. Fiscal
controls apply across that source's books, bases and currencies, so these facts
are deliberately not filtered down to the calling book's accounting basis.
Counts are unsigned decimal strings, including zero, and are never capped at
10,000. The query returns one aggregate row from a single PostgreSQL MVCC
snapshot after book validation; it does not load ledger rows or perform a detail
query for each journal. Its database scan/grouping cost still grows with period
activity and requires representative performance measurement.

A posting group is one transaction, posting date, accounting basis and currency.
`unbalancedPostingGroupCount` counts unequal debit/credit sums or non-finite sums.
Separating these dimensions prevents two wrong journals, currencies, bases or
dates from concealing each other in an overall net-zero total. PostgreSQL numeric
aggregation preserves differences above JavaScript's safe integer range. Existing
database constraints continue to enforce individual posting sign/net rules.

`fiscalPeriods.close` now checks those canonical groups while holding the fiscal
scope's exclusive transaction lock, before creating its close event. It rejects
unbalanced/non-finite groups (`posting_unbalanced`) and pending draft transactions even if the caller
supplies a valid checksum for claims of readiness. Exact completed retries retain
the original lifecycle behavior and do not generate another close event.

The diagnostics are not a close certificate or a complete readiness decision.
They do not prove bank reconciliation, a trial-balance snapshot, completeness of
imported source data, or business approval of unposted operational requests.
`draftInvoiceCount` reports unissued SDK invoices separately from draft canonical
transactions; the generic close command does not impose a new invoice-draft
policy on existing consumers. Hosts must not label an empty draft-transaction
count as evidence that all invoices are issued. SDK-owned immutable close evidence
and BLU's remaining canonical readiness/reconciliation integration are still
required before claiming end-to-end fiscal close completion.

Schema 34 adds a partial source/date index for draft transactions and a covering
source/date/transaction/basis/currency posting index. The diagnostic groups in
that index order and uses scalar period bounds, allowing a streaming grouped
index scan instead of a large hash aggregate. These are physical indexes only;
no accounting rows are rewritten. The normal transactional migration uses
`CREATE INDEX`, so its write-blocking build time on a populated database must be
included in deployment planning. It is not a zero-downtime migration claim.

The opt-in measurement is reproducible with:

```sh
ERP_FINANCIALS_EPHEMERAL_ROOT=/absolute/disposable/directory \
ERP_FINANCIALS_RUN_SCALE_TESTS=1 TZ=Pacific/Auckland \
node scripts/test-ephemeral-postgres.mjs test/fiscal-diagnostics-scale.postgres.test.ts
```

It seeds one million journals/two million postings on schema 33, refreshes parent
table statistics before bulk child inserts, upgrades the populated database to
34, and checks exact counts across sequential/concurrent diagnostics. It records
hardware, PostgreSQL settings, index build time, relation size, latency, memory,
and `EXPLAIN (ANALYZE, BUFFERS)` output. This synthetic, single-source, two-account
workload is not general reporting, native posting throughput, close/post lock
contention, multi-tenant, or production proof. The test is excluded from ordinary
regression unless explicitly enabled.

## Bank reconciliation source and basis boundaries (0.3.86)

A reconciliation write facade owns its selected source within the reporting book.
Commands reject another source's line or match, including match replay and
ignore/unignore/unmatch. Book-wide reads may still include all book sources.
Matching compares the exact signed bank-account postings in the persisted book's
accounting basis; it never adds cash, accrual and modified-cash representations
of the same transaction together. The factory's default posting basis does not
override the book's reconciliation basis.

Real PostgreSQL regressions cover all three book bases, exact money beyond the
JavaScript safe integer range, rejected cross-basis sums, same-book source
isolation and complete database equality after rejected commands. These are
command-level corrections, not a native statement completion/close-evidence API.
The existing one-active-match-per-transaction invariant is unchanged; split bank
lines and transfers involving multiple bank accounts still require separate
capability assessment before relying on this API for those workflows.

## Canonical manual bank statements (0.3.87 / schema35)

`sdk.bankStatements` owns manual statement preparation, bounded posting-selection
deltas, completion, reopen and cancellation. `get` and `find(externalStatementId)`
read the current canonical statement. `activity` pages eligible canonical posting
IDs in date/ID order, with at most500 rows and a statement-version-scoped cursor.
Hosts authenticate/authorize actual actors before calling this trusted server API.
The SDK requires the completing actor to differ from the persisted preparer, and
the reopening actor to differ from the completer. No invented approver is needed.

Closing and opening balances are exact signed decimal strings in the book's base
currency. Positive values follow the bank-asset debit perspective. Preparation
accepts at most500 added and500 removed posting IDs per command, never a whole
ledger replacement. It selects the persisted book basis. First opening balance
is zero: genuine opening financial facts must be canonical postings selected for
clearance. Later opening balances are frozen from the previous completed statement.
Prior uncleared postings remain eligible; prior GL activity is never automatically
called cleared. Unselected amounts are outstanding items, not fabricated bank-feed
lines or automatic ignored evidence. This API makes no financial journal entries.

Only one draft per account/book/source may exist. Completion requires exact zero
difference. Completed selections cannot change, and selected transactions cannot
be retired or reversed until reopened and unselected. Reopen requires a reason;
later dependent statements must first be reopened/cancelled in reverse order.
Cancelling a draft releases selections, preserves its history and original opening
balance, and permits correcting the predecessor. Cancelled statements are terminal.
Every command is atomic with lifecycle evidence and outbox delivery, snapshots its
input, and binds an idempotency key to normalized business content and actor/reason.
An exact retry returns its original historical receipt even after later edits;
call `get` for current state. Fresh transport metadata does not change the receipt.

Schema35 adds scoped statement/clearing tables, finite exact-money constraints,
uniqueness, immutable completion/identity guards, deferred lifecycle-total checks,
correction protection and an index for account/basis/date activity. Migration adds
no historic statement facts. The normal transactional index build can block writes;
its populated-ledger duration/storage costs still need a cutover rehearsal.

These APIs do not certify a bank feed's authenticity, solve split feed matching,
or automatically turn a supplied fiscal-close reference into a verified certificate.
BLU's replacement binding, close-evidence validation, historical statement migration,
source-reset/archive policy, million-row statement workload and live proof remain
required. Existing bank-line matching is a separate ingestion/matching capability;
manual statement selection must not manufacture those imported lines.

`bankStatements.history` pages immutable copies of each added/removed posting's
identity, date, currency, basis and exact amount, linked to its command event and
statement version. This retains completed evidence after reopen/cancellation and
later accounting corrections. History cursors pin the initial maximum version.
Current selection changes require a pending new statement version; equal-value
substitutions cannot silently alter a prepared selection. Both current rows and
history stay inside SDK schema and public APIs.

### Scoped statement lists (0.3.88)

`bankStatements.list({accountId, fromDate, throughDate, includeCancelled?, limit?, cursor?})`
returns current canonical receipts for one scoped account and inclusive date range.
The default excludes cancelled statements; include them explicitly for audit/history.
Results sort by statement date then ID descending, with keyset pagination (default
50, maximum 200). Cursors are bound to tenant, company, source, book, account, dates
and cancellation filter. Pages read one MVCC query over headers and immutable
lifecycle receipts; they do not collect selections or fan out detail queries.
Pages are current reads, not a frozen cross-request snapshot. Refresh after writes.
`BankStatement.externalStatementId` exposes the immutable caller identity, allowing
hosts to amend a selected statement or discover a replacement without maintaining
a second current-statement record. Existing 0.3.87 receipts remain replayable.

### Canonical fiscal readiness diagnostic (0.3.89 / schema35)

`queries.getCanonicalFiscalCloseReadiness(sourceId, fiscalPeriodId, bankAccountIds)`
returns source-wide fiscal diagnostics plus statement checks for the caller's
configured bank accounts in the factory's book. Bank IDs are trusted server
configuration, not an end-user selection or a substitute for an account policy.
The method accepts at most 200 distinct configured account identities; this is
not a posting-row or ledger-size limit. Missing configured accounts fail readiness.

The diagnostic uses one MVCC database statement after book access validation.
It requires a current completed statement at the exact fiscal period end for
each configured account with any activity through that date in the book's basis
and base currency. Prior-period activity still counts, even if this period has
no postings or the account has since become inactive. Cancelled, reopened,
mid-period and other-book/basis statements cannot satisfy that check. Configured
accounts with no such activity are explicitly reported as not requiring a
statement; no fabricated reconciliation reference is returned.

Readiness is false for closed periods, draft transactions, draft invoices,
unbalanced posting groups or unsatisfied bank checks. Exact counts stay strings.
This response is a diagnostic that may change immediately after reading. It is
**not close authorization or an immutable close certificate**. The existing
`fiscalPeriods.close` API still accepts external evidence references; callers must
not treat this diagnostic as an atomic close gate. Use the native command below
when the SDK owns the ledger and bank statements.


### Atomic canonical fiscal close (0.3.90 / schema36)

`commands.fiscalPeriods.closeCanonical` accepts `fiscalPeriodId`,
`expectedVersion`, `idempotencyKey`, `bookId`, trusted configured `bankAccountIds`
and the ordinary authorized `operation`. It closes an open or closing period in
one transaction, without a separate begin-close window. It takes the source
correction lock followed by the exclusive fiscal lock, validates canonical
readiness under those locks, advances the fiscal/book lock, and captures immutable
control totals and statement evidence. Host approval consumption and audit writes
may join the same transaction runner; any failure rolls the entire capture back.

The returned `certificateId` identifies SDK-owned evidence, not caller-provided
hashes. `fiscalCloseCertificates.get`, `.totals` and `.banks` expose that evidence
without direct table access. Totals cover all source accounts, bases and currencies
through the cutoff, with exact decimal opening, period debit/credit and closing
amounts plus period/historical counts. Totals and bank evidence use scoped keyset
pages (default 50, maximum 200); no posting history is collected in JavaScript.
Database guards reject edits, deletion, appending after capture, and incomplete
or inconsistent captures at commit. Capture and deferred verification currently
each aggregate ledger history in PostgreSQL; large-history performance must be
measured for the workload, and is not implied by pagination.

Replay is payload- and actor-bound and returns the same certificate only while the
period remains at that exact closed version/event. Reopening does not change the
historical certificate; replaying the old close then fails instead of reclosing.
Fiscal period reads expose `canonicalCloseCertificateId` for these closes and do
not invent legacy `closeEvidence`. Existing external-evidence `close` remains
compatible for other consumers; a host selecting SDK-only authority must remove
its callers of that path and its legacy financial evidence builders.

Draft creation is serialized with capture but remains non-posting. A draft created
after a completed close does not alter the certificate and cannot be issued into
the closed period. It must be redated or the period explicitly reopened. Bank
configuration remains a host policy responsibility: an empty or incomplete
configuration is not proof that all cash accounts were reconciled. Hosts must not
accept that list from a close request. Schema36 is additive and does not import,
reopen or retire any legacy accounting records.

### Review freshness for native close (0.3.91 / schema37)

Canonical readiness now returns `sourceRevision` and `approvalToken` in the same
MVCC statement as the financial diagnostics and bank checks. A host must persist
this token with the actual reviewed/approved command; `closeCanonical` requires
it as `expectedApprovalToken` and compares it under the source/fiscal locks. A
changed token raises `optimistic_concurrency_conflict` before any close effects.
The token is included in payload-idempotency and immutable certificate evidence.
It is an optimistic freshness check, not authorization: a browser's newly fetched
token must never replace the token saved in an approved host request.

The database maintains `accounting_source_revisions` per source and effective
date. It contains mutation revisions only, no amounts or balances. Statement-level
transition-table triggers track changes to transactions/lines, postings,
subledger documents/lines/applications, invoice drafts and bank statements.
Equal updates and zero-row statements do not increment it; rolled-back changes
roll the revision back. Both old and new dates/scopes of changed records count.
Lines inherit the date of their scoped parent; an unavailable parent conservatively
invalidates all cutoffs. Direct counter changes/deletion are rejected.

The readiness revision sums counters through the fiscal cutoff. This includes
prior-period changes that could alter opening totals, but excludes unrelated
future-period records. An update to an older document still invalidates its older
cutoffs, even if prompted by a later application; this is intentionally conservative.
Book basis/currency, period identity/version, bank policy and statement evidence
also participate in the token. A deferred guard rejects changes to reviewed facts
made later inside the same host transaction after certificate capture.

These counters do not replace financial facts or audit history. Historical
schema36 certificates remain readable without invented tokens; their optional
`approvalToken`/`sourceRevision` fields are absent. BLU's legacy approval hash and
close bindings still require a coordinated cutover to this API.

### Bounded native account-key lookup (0.3.92 / schema37)

`queries.getOperationalAccountByKey({ sourceId, accountKey, asOfDate })` resolves
exactly the key used by `commands.accounts.upsertTree`. It shares the native
command identity algorithm and then uses the same scoped account lookup as
`getOperationalAccount`. The source must belong to the selected tenant/company/
book on the requested date. Missing keys fail; no account-number, provider-ID,
or chart scan fallback occurs. It does not read postings or compute balances.

Use this for trusted configured account keys (for example BLU's `blu-1000`).
An account created/imported only by explicit account ID is looked up by that ID;
this API does not invent native keys for imported records. Inactive definitions
are returned with `active: false`; neither metadata lookup promises future
posting eligibility. Commands must validate their own accounts transactionally.
There is no schema change, and the existing ID-based API is unchanged.

### Historical bank completion in a close certificate (0.3.93 / schema37)

`fiscalCloseCertificates.bankReceipt({ certificateId, accountId })` returns the
immutable completion recorded by that close, or `null` for its explicit
no-activity bank check. A missing certificate/account or wrong tenant/company/
source/book fails with `missing_document`. The read joins the captured event and
validates its identity, version, status, date, basis and currency. It does not
query current bank-statement state, clearings or ledger postings. It remains
valid after the period and statement are reopened and the statement is edited.

Amounts and counts remain exact strings. `recordedAt` identifies the original
completion event; `lifecycleEventId` and `evidenceRef` are its immutable identity.
Native events from before 0.3.88 may lack `externalStatementId`; this optional
label is not synthesized from current state. Use the certificate's paginated
`banks` list and fetch a receipt only for the detail the user opens. No migration
or change to existing bank-page response shapes is required.

### Exact paginated account register (0.3.94 / schema37)

`queries.getAccountRegister({ accountKey, periodStart, periodEnd, limit?, cursor?,
sourceId?, accountingMethod?, includeDescendants? })` returns an account definition,
opening net before the requested window, period debit/credit/count, closing net,
and at most 200 posted lines with exact running net. All amounts and counts are
strings. This API uses the SDK's cent-precision money contract; it rejects stored
nonzero sub-cent amounts instead of silently truncating them. Trailing numeric
zeroes are normalized. Currency-specific scales beyond that contract require
separate SDK support. Net always means debit minus credit; normal-side display formatting is
a host presentation concern. The account key is the reporting-book key, or the
unmapped `sourceId:accountId` key. Inactive accounts retain posted history.

Direct activity is the default. `includeDescendants: true` explicitly includes
hierarchy descendants; do not add a parent's inclusive total to its children.
Only source bindings effective on each posting date participate. The selected
book currency and requested/default book basis apply to opening and period
activity alike. A source filter outside the book produces no activity; a missing
account is `missing_document`.

Opening, totals, rows, running amounts and accounting revision share one SQL
statement snapshot. Rows sort ascending by posting date and posting ID. The
cursor is bound to tenant/company/book and normalized filters, and records a
revision derived from book/account/mapping metadata and dated accounting source
revisions. Backdated changes or metadata changes reject an old cursor with
`optimistic_concurrency_conflict`; restart at page one. Future-dated posting
beyond the window does not invalidate it. Revision tracking is conservative and
source-wide: an in-window posting to another account in a contributing source
can also invalidate the cursor. Hosts must offer an explicit reload rather than
looping indefinitely on stale cursors; usability under sustained live posting
requires separate verification. Book archival during the read also fails closed. Cursor amounts are never trusted; PostgreSQL computes the prefix
and windows only the bounded page. Page selection takes ordered, index-backed
candidates per physical account and merges at most the requested global page.
No full ledger is collected into application memory, but exact summaries and
precision validation still aggregate the relevant history in PostgreSQL.

Hosts must display the returned opening/running/closing values directly. Never
label today's chart balance as opening and then add the same journal history.
This additive API does not change existing GL list or summary contracts and
requires no schema migration beyond schema37's accounting revision tracking.

### Paginated account chart and whole-book controls (0.3.95 / schema37)

`queries.getAccountChart({ periodStart, periodEnd, limit?, cursor?, search?,
classification?, includeInactive?, accountingMethod? })` replaces whole-chart
collection and host balance reconstruction. It returns at most 200 definitions
with `direct` and `inclusive` opening/debit/credit/closing totals and posting
counts. `direct` is posted to that account alone. `inclusive` includes each
hierarchy descendant once. Never add inclusive parent totals to child totals.
Both are debit-minus-credit amounts; normal-side display is presentation only.

The response's `summary` contains whole-book direct controls, trial debit/credit
balances and per-classification totals. These controls never change merely
because a user searches or filters displayed rows. `matchedAccountCount` counts
matching definitions; `summary.accountCount` counts the whole book's definitions,
including zero-balance headers and inactive definitions. Search is a literal,
case-insensitive substring (maximum 100 characters) in number/name/key.
`includeInactive` defaults true; false retains inactive accounts with direct
opening, period activity or closing balances. No source-account ID collection or
per-account detail fanout is returned. Posting eligibility is still a command
responsibility; the chart is not a substitute for transactional account guards.

Each response calculates definitions, direct and inclusive amounts, summary,
rows and revision in one financial SQL snapshot. Source windows apply to each
posting. Rows sort by classification, account number (or key when absent), then
key. Cursors bind tenant/company/book/window/filters and the same conservative
dated accounting revision used by the account register. Backdated posting,
mapping or metadata changes require restarting at page one. This rejects stale
pages rather than mixing independently authoritative balances.

The read rejects cyclic source hierarchies, ambiguous fallback/book keys, and
nonzero sub-cent facts. It does not silently truncate, repair data, or add legacy
opening-balance fields. Empty books return explicit zero controls and no rows.
The existing `listChartOfAccounts` API remains unchanged for shared-consumer
compatibility. No migration is added; schema37 is required for revision reads.

### Complete posted journal reads (0.3.96 / schema38)

`queries.getJournalRegister` and `queries.getJournalPostingPage` provide bounded,
exact, posting-date-based journal reporting across native and imported canonical
facts. Both expose a snapshot revision and reject stale continuation cursors.
Public request/page/item/totals types are exported from the root and `/sdk`.
See [the GL contract](general-ledger-contract.md#complete-posted-journal-register-0396--schema38)
for reporting versus source-document status, optional actual preparer evidence,
window controls, paging and the additive detail index. Existing manual-journal
query contracts remain compatible and must not be mistaken for the full ledger.

### Bounded command-account selection (0.3.97 / schema38)

`queries.listOperationalAccounts({ sourceId, asOfDate, search?,
includeUnavailable?, limit?, cursor? })` returns live account metadata and a
continuation cursor. Page size defaults to50, maximum200; there is no whole-list
ceiling. Search is literal and includes source/reporting numbers and names.
Choose the returned `accountId` for a source-scoped command. `bookAccountKey` is a
reporting identity, not a substitute command-account ID. The read returns no
ledger balances and performs no financial-fact queries or command authorization.

Default results require an active source account and, if mapped, an active book
posting account. `includeUnavailable` also exposes inactive definitions with
`accountEnabled=false`. `accountEnabled` only describes these account metadata
checks at read time. It is not permission to post, nor does it assert an open
fiscal period or valid source policy. The command rechecks lifecycle rules while
holding its transaction locks. A deactivation after selection must reject a new
posting; do not add a host workaround or stale local account eligibility rule.

Cursors bind tenant/company/book/source/date/search/availability filters and sort
by displayed account number then canonical source-account ID. This is live
metadata pagination, not a frozen accounting report: rename/create/deactivation
can change the next page. Reload the selector when its context changes. Every
page rechecks book and dated company/source membership in its single SQL snapshot.
Hosts must retain the cursor and use the authorized configured write source;
never collect every page to reconstruct a legacy chart or accounting authority.

### Reporting-account reference lookup (0.3.99 / schema38)

`queries.resolveReportingAccount` accepts an explicit `book_key` or
`account_number` reference plus `asOfDate`, returning one scoped metadata
definition without reading balances. Duplicate numbers and key collisions fail
closed. See [reporting-account deep links](general-ledger-contract.md#reporting-account-deep-links-0399--schema38).

### Journal origin groups and exact reference filtering (0.3.100 / schema38)

`JournalOriginGroup` and the optional journal-register request/result fields
provide bounded server-configured categories, exact group totals and selected
group filtering in the report snapshot. `reference` performs exact journal
identity/number filtering, reporting ambiguous matches rather than guessing.
See [the GL contract](general-ledger-contract.md#bounded-journal-origin-groups-and-exact-references-03100--schema38).

As of 0.3.124 (schema 40 unchanged), invoice economic replacements accept an
optional `replacement.accountPolicy` with nonempty `revenueClassifications` and
`receivableClassifications` lists. The SDK validates scoped active accounts in
one batch and holds SHARE row locks through the correction transaction, so
classification/activity edits cannot race a successful policy check. Policy is
recorded in completion evidence and part of the immutable correction payload: changing or removing it conflicts
with an existing completion. An exact completed retry remains readable after
later account edits. Existing callers without a policy retain their behavior;
this is an explicit application policy, not a new universal chart assumption.
Only replacement commands gain this policy in this revision. Ordinary draft
creation/issuance contracts and overdue due-date rules are unchanged.
