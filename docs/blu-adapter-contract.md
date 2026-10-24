# BLU Adapter Contract (Pre-v1)

This document defines the supported boundary between BLU and
`@handrail/erp-financials`. It is an adoption contract for one BLU server-side
adapter, not an instruction to expose SDK objects directly to BLU routes or
React code.

The executable source of truth is
[`test/blu-erp-consumer-type-imports.ts`](../test/blu-erp-consumer-type-imports.ts).
That harness imports only `@handrail/erp-financials/sdk` and is compiled by
[`tsconfig.blu-erp-consumer.json`](../tsconfig.blu-erp-consumer.json).
[`test/package-boundary.test.ts`](../test/package-boundary.test.ts) verifies that
the harness and its TypeScript path mapping use declared package exports rather
than `src`, `dist`, or another private path. The tables below name only that
proven public surface.

## One scoped SDK

BLU creates one SDK instance at server composition time and injects it into its
finance services. Scope is stable configuration, not route input.

| BLU adapter value | SDK field | Contract |
|---|---|---|
| Stable BLU tenant identity | `tenantId` | `tenant_blu` in the harness; never accepted from an untrusted route parameter. |
| Stable BLU company identity | `companyId` | `company_blu`; BLU is one company today but the identity remains explicit. |
| Primary reporting book | `bookId` | `book_blu_usd_accrual`; all canonical reads resolve through this book. |
| Native BLU provenance source | `writeSourceId` | `source_blu_native`; every new BLU accounting fact retains this source identity. |
| Book currency | `currencyCode` | `USD`; pre-v1 does not approximate foreign-currency accounting. |
| Accounting basis | `accountingBasis` | `accrual`. |
| Posting enforcement | `postingPolicy` | `enforce_fiscal_periods`; BLU must not use `legacy_unrestricted` to bypass close controls. |
| Database boundary | `database` | BLU supplies its server-side Postgres pool or transaction runner; database installation and runtime registration are separate operational gates. |

The supported factory shape is `createErpFinancialsSdk({ database,
...stableScope })`, as demonstrated by `createBluFinancialsSdk(...)` in the
harness. BLU must not create different books or sources per request to simulate
route-local ledgers.

## Money and identity adapters

BLU owns conversion from its integer-cents representation to the SDK's fixed
decimal strings. Conversion must operate on integer or string digits—such as
splitting a `bigint` into sign, whole cents divided by 100, and a two-digit
remainder—and must never pass through a JavaScript floating-point `number`.
For example, `125000n` becomes `"1250.00"`. The reverse route adapter parses
SDK decimal strings losslessly before producing any BLU cents field. Display
formatting and rounding are presentation concerns and cannot feed accounting
writes. Quantities and unit amounts also cross the SDK boundary as decimal
strings at the scale required by their SDK fields.

The harness deliberately rejects an integer `number` as SDK money and asserts
decimal-string types for command amounts, ledger lines, statement totals,
aging totals, and reconciliation totals.

| Identity | BLU-to-SDK mapping rule |
|---|---|
| Account | Keep stable BLU source account IDs and stable reporting `accountKey` values. Define the book chart once, then map each source `accountId` to its book key; do not map by display name. |
| Party | Keep stable `customerId` and `vendorId` values across invoices, receipts, applications, bills, payments, backfills, and retries. |
| Document | Preserve stable invoice draft, issued invoice, customer-payment, vendor-bill, and bill-payment IDs or deterministic source crosswalks. Preserve document numbers as business evidence, not as the only identity. |
| Transaction | Preserve the canonical `transactionId` returned or crosswalked for journal detail, reversal, correction, and statement-line matching. |
| Application | Preserve `paymentApplicationId`; apply/unapply addresses the canonical application rather than editing balances locally. |
| Statement line | Keep the bank feed's stable `externalLineId` and canonical `bankStatementLineId`. For a matched line, reload `bankReconciliationMatchId` and `bankReconciliationMatchVersion` from `listBankReconciliation`; command-response-only evidence is insufficient. A monthly statement balance alone is not reconciliation identity. |
| Idempotency | Derive one stable `idempotencyKey` for each logical command and reuse it for an identical retry. Do not generate a new key merely because an HTTP request was retried. |
| Request and correlation | Every mutation carries a stable `operation.requestId` and an end-to-end `operation.correlationId`; BLU may also keep its HTTP identifiers in its route layer. |
| Actor | Set `operation.actorRef` to the authenticated BLU principal after BLU authorization. Never accept the durable actor solely from request JSON. |
| Independent approver | Commands requiring approval carry `operation.approverRef` for a different, independently authorized principal. BLU's approval evidence must be resolved before calling the approved SDK operation. |
| Optimistic version | Read and retain canonical versions, then pass the applicable `expectedVersion`; on conflict BLU refetches and presents the error rather than overwriting state. |

## Supported command mapping

### Book and chart setup

| BLU responsibility | Public SDK operation | Adapter requirement |
|---|---|---|
| Define the USD accrual reporting book | `sdk.books.define` | Stable book identity, `USD`, accrual basis, and active status. |
| Bind the native source | `sdk.books.bindSource` | Stable source role and non-overlapping effective dates. |
| Define reporting-book accounts | `sdk.books.defineAccount` | Stable book account key, classification, role, currency, and optimistic version. |
| Map BLU source accounts | `sdk.books.mapAccount` | Stable source account ID to stable book account key. |
| Upsert the native account tree | `sdk.commands.accounts.upsertTree` | Parent/child keys and classifications; ERP Financials validates hierarchy and invalidates affected reads. |

### Accounting lifecycles

| BLU intent | Public SDK operation | Boundary behavior |
|---|---|---|
| Resolve an uncertain hold/release | `sdk.commands.vendorBills.retirePaymentHoldAttempt` | Persist the exact original actor/scope/key/payload and permanent cancellation mode. An accepted result returns historical receipt separately from current hold/version; an unaccepted cancellation fences the original key. No host hold shadow or direct SDK SQL. |
| Hold/release an outstanding native bill | `sdk.commands.vendorBills.setPaymentHold` | Authorize the actor, pass the current SDK bill version, reason and idempotency key; SDK state and database application enforcement own the hold. Host approval evidence remains operational, not another financial status. |
| Post a balanced journal | `sdk.commands.journalEntries.post` | BLU supplies stable idempotency and decimal-string debit/credit lines; ERP Financials enforces balance and fiscal state. |
| Reverse a journal | `sdk.commands.journalEntries.reverse` | Approved compensating entry against the stable original transaction. |
| Correct and replace a journal | `sdk.commands.journalEntries.correct` | Approved immutable correction plus a balanced replacement; never edit posted rows. |
| Define a fiscal period | `sdk.commands.fiscalPeriods.define` | Stable year, period number, and inclusive dates. |
| Begin close | `sdk.commands.fiscalPeriods.beginClose` | Independent approval and optimistic version. |
| Close a period | `sdk.commands.fiscalPeriods.close` | Independent approval plus BLU checklist reference and canonical trial-balance/reconciliation evidence. |
| Reopen a period | `sdk.commands.fiscalPeriods.reopen` | Independent approval and optimistic version. |
| Set a posting lock | `sdk.commands.fiscalPeriods.setPostingLockDate` | Independent approval and optimistic version; BLU does not enforce a weaker parallel lock. |
| Create or update an invoice draft | `sdk.invoices.createDraft`, `sdk.invoices.updateDraft` | Stable customer/order crosswalks, decimal commercial lines, and expected version on update. |
| Read native draft provenance, including after issuance | `sdk.invoices.getDraft` (0.3.103) | Exact draft ID in the configured tenant/company/book/write source/currency. Returns retained draft metadata and lines under a shared header lock; posted document IDs are not draft IDs. Host authorization remains required. |
| Void a draft | `sdk.invoices.voidDraft` | Optimistic lifecycle transition before posting. |
| Issue a draft | `sdk.invoices.issue` | Stable idempotency; ERP Financials posts the canonical invoice atomically. |
| Void an issued invoice | `sdk.invoices.voidIssued` | Independent approval and compensating canonical workflow. |
| Record invoice delivery | `sdk.invoices.recordDelivery` | Append-only delivery status, channel, safe recipient reference, and occurrence time. BLU still sends/presents the invoice. |
| Record customer cash | `sdk.commands.customerPayments.record` | Stable customer, cash/receivable accounts, idempotency, and decimal amount. |
| Apply or unapply customer cash | `sdk.commands.paymentApplications.apply`, `sdk.commands.paymentApplications.unapply` | Stable documents/application, exact amount, expected versions, and approved effective-date unapplication. |
| Post an approved vendor bill | `sdk.commands.vendorBills.create` | Call only after BLU's approval/hold/release workflow permits posting. The SDK command creates the posted accounting bill; BLU must not maintain a second posted bill ledger. |
| Void or replace a posted vendor bill | `sdk.commands.vendorBills.voidPosted`, `sdk.commands.vendorBills.replacePosted` | Independent approval, expected version, idempotency, and immutable compensation/replacement. |
| Record and apply an immediate bill payment | `sdk.commands.billPayments.recordAndApply` | Call only for a BLU-authorized payment; allocations carry stable bill IDs, exact amounts, and expected bill versions. |
| Schedule, clear, or cancel a bill payment | `sdk.commands.billPayments.schedule`, `sdk.commands.billPayments.clear`, `sdk.commands.billPayments.cancel` | Keep instruction and accounting lifecycle canonical; clearing is the posting transition. |
| Void and unapply a bill payment | `sdk.commands.billPayments.voidAndUnapply` | Independent approval and one compensating canonical operation. |
| Ingest a bank statement line | `sdk.bankReconciliation.ingest` | Stable external line ID, account, date, currency, and decimal amount. |
| Match or unmatch a statement line | `sdk.bankReconciliation.match`, `sdk.bankReconciliation.unmatch` | Match individual canonical statement lines to transactions. After any reload, unmatch uses the persisted `bankReconciliationMatchId` and `bankReconciliationMatchVersion` returned by the bounded reconciliation read. A stale match version returns `optimistic_concurrency_conflict` before audit or state mutation. |
| Ignore or reopen a statement line | `sdk.bankReconciliation.ignore`, `sdk.bankReconciliation.unignore` | Ignore an unmatched line at its current line version. Reopening is the audited `ignored` to `unmatched` correction: it requires actor, distinct approver, stable request/correlation IDs, reason code and detail, occurrence time, and the reloaded statement-line version. A stale version conflicts without mutation; retrying the identical request ID returns the same resulting open line without duplicate audit or outbox evidence. |

The harness is the allowlist. Other SDK features are not part of the approved
BLU adapter contract until the harness and this document are deliberately
extended together.

## Supported read mapping

BLU adapts these canonical results into its existing route response shapes. It
must preserve the SDK's filters, cursors, limits, decimal totals, statuses,
versions, and evidence rather than loading a broad fact set and recomputing the
same accounting result in application code.

| BLU surface | Public SDK query | Canonical result |
|---|---|---|
| Chart of accounts | `sdk.queries.getAccountChart` | Bounded reporting-account page and exact whole-book/window controls in one snapshot. |
| Existing account-number deep links | `sdk.queries.resolveReportingAccount` | Exact scoped metadata lookup; ambiguity fails rather than guessing a reporting identity. |
| Account register | `sdk.queries.getAccountRegister` | Bounded posting page, exact opening/closing/running balances and revision-bound cursors. |
| Command-account choices | `sdk.queries.listOperationalAccounts` | Bounded metadata-only choices with source-scoped canonical account IDs. |
| Journal register and detail | `sdk.queries.getJournalRegister`, `sdk.queries.getJournalPostingPage` | Complete native/imported posted facts, bounded pages, exact controls and revision-bound cursors. Older native manual-journal queries remain compatibility APIs. |
| Fiscal periods and posting lock | `sdk.queries.listFiscalPeriods`, `sdk.queries.getPostingLock` | Canonical period states/versions and source posting lock. |
| Fiscal ledger diagnostics | `sdk.queries.getFiscalCloseDiagnostics` | Exact source-wide posting-group and draft counts, one SQL aggregate. Close itself rejects unbalanced groups under its posting lock. This is not an immutable trial-balance snapshot, bank reconciliation proof, or a complete close checklist. |
| General ledger and totals | `sdk.queries.listGeneralLedger`, `sdk.queries.getGeneralLedgerSummary` | Bounded ledger page plus independently aggregated debit, credit, and difference totals. |
| Invoice register, detail, and totals | `sdk.queries.getInvoiceRegister`, `sdk.queries.getInvoice` | Current financial state, bounded register page and whole-scope totals in one snapshot; the cutoff labels age/overdue state rather than reconstructing historical balances. |
| Customer statement | `sdk.queries.getCustomerStatement` | Bounded as-of invoice rows, application evidence, source identity, and statement totals for one customer. |
| Vendor-bill register, detail, and totals | `sdk.queries.listVendorBills`, `sdk.queries.getVendorBill`, `sdk.queries.getVendorBillSummary` | As-of posted bill lifecycle/open balances and complete filtered summary. |
| Customer-payment register and detail | `sdk.queries.listPayments`, `sdk.queries.getCustomerPayment` | Filtered customer-payment page and exact canonical receipt/application evidence. |
| Bill-payment register, detail, and totals | `sdk.queries.listBillPayments`, `sdk.queries.getBillPayment`, `sdk.queries.getBillPaymentSummary` | Bounded disbursement lifecycle, allocations, posting evidence, and complete filtered summary. |
| Payment applications and totals | `sdk.queries.listPaymentApplications`, `sdk.queries.getPaymentApplication`, `sdk.queries.getPaymentSummary` | Bounded application evidence and complete filtered payment KPIs. |
| Reconciliation review and totals | `sdk.queries.listBankReconciliation`, `sdk.queries.getBankReconciliationSummary` | Bounded individual-line review plus complete canonical reconciliation totals. Every `status: "matched"` item includes its persisted match ID and match version so a host can unmatch safely after reload; ignored and open lines retain their statement-line version for correction concurrency. |
| Profit and loss | `sdk.queries.getFinancialStatement({ reportName: "profit_and_loss", ... })` | Canonical statement lines and totals for the requested period. |
| Balance sheet | `sdk.queries.getFinancialStatement({ reportName: "balance_sheet", ... })` | Canonical as-of book balances. |
| Trial balance | `sdk.queries.getFinancialStatement({ reportName: "trial_balance", ... })` | Canonical debit/credit balance evidence. |
| Receivables and payables aging | `sdk.queries.getAgingPage` with `kind: "receivables"` or `"payables"` | Bounded party rows with complete as-of buckets, party count and totals in one snapshot. |
| Financial dashboard | `sdk.queries.getDashboardSummary` | SDK 0.3.146+: one SQL snapshot of book configuration, ledger totals and effective-date gross open invoices/bills. Equity includes retained/current earnings, matching the balance sheet. |

Summary values must cover the complete requested scope, whether returned with
the page or by a separate summary query. BLU must not sum only the current page. Operational reports such as labor, production, and web
projections remain BLU calculations and are not advertised as SDK reads.

## Ownership boundary

| Owner | Owns | Does not own |
|---|---|---|
| BLU | React FRM workspaces; existing route response shapes; authentication and authorization; order, customer, vendor, PO, and receipt relationships; bill approval/hold/release; operational reports; close-checklist presentation; cents/decimal conversion; HTTP and error presentation; runtime/job registration; calls to the Handrail QuickBooks service. | Accounting invariants or a second ledger; host-local standard-statement SQL; Intuit credentials; raw unbounded provider payloads. |
| ERP Financials | Accounting persistence and invariants; reporting books and chart mapping; balanced posting; lifecycle state; optimistic concurrency; idempotency; fiscal locks; immutable corrections; applications; reconciliation evidence; bounded SQL reads and complete totals; outbox records; rollups, snapshots, and freshness; canonical QuickBooks facts after normalized handoff. | BLU UI/routes/authorization/workflows; OAuth, tokens, provider clients, or direct QuickBooks API calls; raw unbounded provider payloads. |
| Handrail QuickBooks integration | OAuth and token custody; provider clients and API calls; normalized full/incremental responses; sync checkpoints; provider-report calls and parity evidence. | BLU workflow state or canonical accounting persistence. |

The normalized provider handoff follows
[`quickbooks-boundary.md`](quickbooks-boundary.md): BLU calls the Handrail
service, then passes bounded normalized responses into ERP Financials. Neither
BLU nor ERP Financials stores Intuit credentials or raw, unbounded QuickBooks
responses.

## Pre-v1 adoption and release rules

- BLU compiles only against declared package exports. The approved adapter uses
  `@handrail/erp-financials/sdk`; it never imports package `src`, `dist`, or an
  undeclared subpath.
- BLU pins the exact published tag that actually contains and passes the
  approved BLU harness. Package version `0.3.32` is the first release of this
  contract, published as the immutable `v0.3.32` Git tag. The exact dependency
  spec, approved commit, publication safeguards, and clean-consumer evidence
  are recorded in [blu-v0.3.32-release.md](blu-v0.3.32-release.md).
- Breaking contract changes remain possible before 1.0. A gap found during BLU
  adoption is ERP Financials contract work: extend the public SDK, its harness,
  and tests here instead of adding BLU-local accounting SQL or a second ledger.
- Migration may use a short, explicitly bounded parity period, but must not
  become indefinite dual-writing. Backfill, replay, parity evidence, command/read
  cutover, and retirement of legacy accounting writes are separately planned.
- Database migrations, backfill/parity, runtime registration, provider
  configuration, deployment, backups, and production-readiness review remain
  separately gated operational work. This document authorizes none of them.
- Install and migration code follows the current
  `POSTGRES_CANONICAL_SCHEMA_MANIFEST`; documentation must not assume an older
  hard-coded schema version.

This contract does not implement BLU application code, QuickBooks clients,
deployment/configuration, UI changes, migrations, or a package release.

## Related boundaries

- [`sdk-v1-contract.md`](sdk-v1-contract.md) defines the generic pre-v1 SDK
  lifecycle, error, retry, currency, runtime, and readiness rules.
- [`architecture.md`](architecture.md) assigns UI, permissions, navigation, and
  customer-specific workflows to host applications.
- [`quickbooks-boundary.md`](quickbooks-boundary.md) assigns provider access,
  credentials, normalized responses, and provider evidence to the Handrail
  QuickBooks integration.

### Order attribution and creation retries (0.3.103)

BLU's new native invoice revenue lines carry a `blu_order` dimension whose
`sourceDimensionId` is the immutable operational order UUID. The SDK carries
commercial-line dimensions into accrual postings and cancellation credit lines;
metadata alone does not attach an order to posted ledger entries. This is a
source-scoped identity, not a globally unique reporting group across sources.

BLU stores `bluOrderAttributionVersion: 1` alongside `bluOrderId` and
`bluInvoiceLinkId` in SDK draft metadata. On a creation retry, BLU reads the exact
retained draft through `invoices.getDraft`, checks the operational relationship,
and uses its original request format. Drafts created before the marker retain
version-zero payloads without dimensions. The SDK still checks the full command
checksum; reading metadata does not authorize a different amount, actor, order,
or key. Future draft editors must preserve this host format marker. Missing or
unsupported provenance must fail closed, never create a replacement invoice.

This does not backfill old postings, allocate purchasing costs, classify CI/BC
channels, or implement an order-profit report. Reports must retain explicit
unattributed/ambiguous controls until verified attribution exists. Do not infer
attribution from memo text or silently spread unassigned costs across orders.

### Contractual invoice dates and historical AR aging (0.3.125 / schema 41)

Invoice due dates express contractual terms, independently of the recognition
or correction posting date. Native invoice creation, draft creation/edit/date
edit/issuance, approved date restatement, and economic replacement accept an
already-past due date. They still require real ISO calendar dates. Posting dates
still pass fiscal/approval/concurrency checks. A replacement posts on its approved
correction date; hosts must not backdate it or silently extend the due date to
satisfy a former chronological guard. BLU's approval-intent schema requires its
matching forward migration. Existing requests and dates are not rewritten.

Schema 41 widens only the invoice subledger date check and removes the draft's
chronological check. Vendor bill support remains; other document types retain
the original check. The migration runs transactionally, takes table locks, and
validates the new subledger constraint. Rehearse its lock/scan cost on production-
sized copies before scheduling it; small integration fixtures are not scale
proof. An injected failure after the DDL is tested to roll back constraints,
migration receipts, and business facts. After accepting overdue invoices, an
application downgrade may reject valid data, and reintroducing the old checks
may fail. Prefer a compatible forward repair. Any database recovery must retain
post-cutover facts; never change dates to force a downgrade or restore an old
snapshot over new accounting activity.

AR aging now reconstructs native balances using application and release effective
dates, including native receipt-return settlement and cancellation credit
applications. It preserves the public report's existing **net** contract:
unapplied customer receipts and credits are negative aging amounts, aged from
their document date; invoice balances age from contractual due dates. Customer
statements show gross unpaid invoices, so reconcile their outstanding total
less unapplied receipts/credits to net AR aging. AP aging remains gross.

QuickBooks documents whose latest snapshot is effective by the requested date
retain provider-owned open balances, as in the existing AP register. A provider
snapshot without complete historical application evidence cannot prove earlier
balances. This change does not invent missing import history. Imported-history
reconciliation and large-ledger query measurements remain separate release gates.

### Invoice settlement composition (0.3.126 / schema 41)

`queries.getInvoice` and the bounded `queries.getInvoicesByIds` now return
`settlement` in the same SQL snapshot as the invoice header, version and lines.
The exported `InvoiceSettlementSummary` distinguishes active cash applications,
ordinary credits, write-offs and the specific credit application that cancels
an invoice. These are exact decimal amounts. Ended applications are excluded.
An unapplied receipt remains customer cash; it is not cash applied to this invoice.
A cancelled invoice can therefore have zero cash applied and its full original
amount in `cancellationAmount` while the cash is retained or applied elsewhere.

The invariant is `originalAmount - openAmount = cashAppliedAmount +
creditAppliedAmount + writeOffAppliedAmount + cancellationAmount +
unclassifiedAmount`. A positive unexplained reduction is explicitly
`unclassifiedAmount`, never guessed to be a cash payment. Consumers must expose
that uncertainty or require reconciliation. Negative amounts or a negative
unclassified remainder fail with `reconciliation_conflict`. The host must not
recalculate these figures from an application-history collection.

`basis: "current"` is deliberate: this summarizes the current invoice balance,
not gross lifetime receipts, refunds, or a historical cash-flow statement.
The existing invoice detail `asOfDate` controls the overdue label; it does not
make current applications and balance historical. Use the historical statement
and aging APIs for their documented effective-date views. Full invoice
historical settlement composition remains a separate verification requirement.

The field is optional in the exported `InvoiceDetail` type to preserve source
compatibility with existing consumer bindings; this version returns it for every
returned invoice/draft detail. Drafts have zero applied amounts. Consumers requiring
this breakdown must version-gate it and fail explicitly if it is absent.
No new schema migration or direct consumer access to SDK tables is required.
The aggregation uses the existing scoped target/status application index and the
100-ID detail batch bound; this is not a million-entry performance certification.

### Historical customer-statement settlement (0.3.127 / schema 41)

`getCustomerStatement` returns `settlement` on each invoice, whole-statement
`totals`, and `pageTotals`: `cashAppliedAmount`, `creditAppliedAmount`, and
`writeOffAppliedAmount`. These sum exactly to `appliedAmount`. Cash means cash
allocated to these invoices at the cutoff, not gross receipts or net cash flow.
BLU must use the cash component for its `paidCents` compatibility field and expose
noncash components separately. It must not equate a closed balance with payment.
Negative classifications, inconsistent sums, or overapplied historical invoices
fail with `reconciliation_conflict` rather than silently clamp an invalid balance.

Cancellation takes effect on the protected cancellation application's accounting
date. The invoice is excluded from that date onward, including when the operation
was recorded later. A replacement is included from its own posting date, avoiding
an original-plus-replacement double count. Before cancellation, ordinary historical
cash, credit and write-off applications retain their effective application/end dates.
The original cancellation remains available through invoice detail/audit; this
statement is not a cancellation activity report.

`includeApplications: false` omits the potentially large application JSON arrays
while retaining identical totals and classification from the same SQL snapshot.
`applicationsIncluded` describes the returned shape; default true preserves existing
consumers. Cursors are bound to this option as well as customer/date/book. New fields
are optional in TypeScript for older consumer source compatibility; requiring hosts
must reject a missing classification rather than use an accounting fallback.

This is a report of recorded canonical application history. It does not manufacture
missing historical provider evidence, establish import reconciliation, or prove
million-entry performance. The bounded BLU pagination and cross-page consistency
contract are described below. No new migration is needed.

### Statement pagination consistency (0.3.128 / schema 41)

Each statement response carries an SDK `revision`. A continuation cursor binds
its tenant, company, book, customer, cutoff, evidence option and revision. A
changed revision raises `optimistic_concurrency_conflict`; restart from the first
page. Cursors from earlier SDK versions must also be restarted. This is optimistic
consistency, not a long-lived database transaction or permission grant.

Revision, totals, classification and page rows share one SQL snapshot. The revision
uses the existing database-managed source/date counters, book/source definitions
and the scoped customer's metadata. Unapply/reapply changes invalidate a cursor
even if monetary totals return to their former values. Conservative invalidation
may also occur when another customer changes within the same source/date range.
No full ledger hash or application-history aggregation is performed in application
memory. Sustained scale and contention measurements remain required.

BLU `GET /api/finance/statements/:id` now accepts `limit` (1–200, default 50) and
`cursor`. A continuation must explicitly repeat the original `asOf` date. Response
`statement.invoices` contains one page; top-level amounts and `invoiceCount` cover
the entire statement, `pageTotals` covers this page, and `nextCursor` indicates
continuation. Clients must not treat one page as the entire statement or concatenate
pages after a 409. Responses use `Cache-Control: no-store`. There are no current BLU
frontend callers that require an automatic full-list compatibility path.

BLU requests one SDK page without application JSON and one bounded operational
metadata batch for native originals, replacements and migration crosswalks. The
metadata query contains identities and customer/order labels only. Conflicting
owners fail closed; no legacy invoice financial tables are read. Other invoice
list/detail fanout paths remain separate work.

### Original invoice account execution policy (0.3.129 / schema 41)

`createErpFinancialsSdk`, `createErpFinancials`, and `createInvoiceWorkflow` accept
optional `invoiceAccountPolicy: { revenueClassifications, receivableClassifications }`.
The SDK validates and copies these nonempty classification lists at construction.
BLU configures revenue as `income` and receivable as `asset` in its shared factories.
Other consumers retain their previous classification behavior when omitted.

The policy constrains **new execution**: draft creation/full edits, direct invoice
posting, draft issuance, and replacement drafts/issuance. Draft validation does not
substitute for issuance validation. Active scoped accounts and classifications are
checked again under transaction-held row locks. Account-hierarchy advisory locks
precede row locks, matching the account editor and posting paths. The existing
source serialization remains; its throughput is not certified by these tests.

The configured policy is an execution guard, like posting policy, rather than an
extra economic command parameter. Historical identical retries return their saved
receipts before re-execution checks, including receipts created before configuration
was introduced. Changing economic payload or actor still conflicts. The existing
explicit replacement `accountPolicy` remains bound to its command checksum; the
configured policy also applies and cannot be weakened by omitting that field.
New draft lifecycle evidence records `executionAccountPolicy`; posting evidence
records the account requirements actually enforced. This does not relabel earlier
postings or claim they complied with a later policy.

BLU removed its pre-command `loadAccounts` classification check, which could both
become stale before issuance and prevent recovery of historical retries after an
account changed. Its public invoice command gate requires SDK0.3.129 before writing.
Account identity crosswalks and operational party identity remain host concerns.
No schema migration or installed dependency change is part of this checkpoint.

### Bounded invoice receipt evidence (0.3.130 / schema 41)

`queries.getInvoiceReceiptPage(invoiceId, { asOfDate?, limit?, cursor? })` returns
one invoice detail and one page of its **current active cash applications** in the
same financial SQL snapshot. It does not replace `getInvoice` or `getInvoicesByIds`;
ordinary callers retain their response shape and do not run receipt-page work.
The existing book preflight is a separate query; invoice details and statements
now verify that the book's status, currency and basis still match in the financial
query's snapshot. An intervening change raises `optimistic_concurrency_conflict`.

The receipt response has `basis: "current"`, `invoice`, `items`, `revision`,
`totalApplicationCount`, `totalAppliedAmount` and optional `nextCursor`. Limit is
1–200, default50. Rows are ordered by application date and application ID descending.
Each row has an application ID/amount/date plus receipt ID, source, customer,
currency, date, creation timestamp, posting identity and available actor/memo
provenance. One receipt may have several allocations to the invoice: use the
application ID for row identity and do not count allocations as separate receipts.
Credit/write-off/cancellation reductions remain in `invoice.settlement`, never in
this cash page. Ended allocations are excluded.

`totalAppliedAmount` must match the invoice's cash-applied settlement. Missing,
voided, cross-customer or excluded-book receipt evidence fails reconciliation; it
is not silently omitted or replaced with legacy amounts. Summary count and dates
cover all current cash applications, not the selected page. `latestReceiptDate`
and `latestApplicationDate` are distinct maxima; neither alone is asserted to be
an invoice's historical fully-paid date. `asOfDate` only controls the existing
invoice overdue label; this is explicitly not a historical balance query.

Continuation requires the original explicit `asOfDate`. The cursor binds scope,
invoice, cutoff and an SDK revision of the invoice view, book/source definitions
and database-managed source revisions. Offsetting unapply/reapply events invalidate
it even if totals return to their old values. Restart the detail on a conflict;
never concatenate pages from different revisions. Other changes in the invoice's
source can conservatively invalidate continuation. Receipt rows are bounded in
application memory; PostgreSQL still aggregates the invoice's active allocations.
No million-entry throughput claim follows from the 205-allocation pagination test.

This SDK checkpoint does not yet switch BLU's detail adapter or add its HTTP/UI
continuation. BLU must replace its full application collector and per-receipt reads,
preserve application identity, expose bounded navigation, and stop deriving dates
from a partial receipt array. That cutover and its browser/HTTP checks remain open.

### Current invoice register (0.3.131 / schema 42)

`queries.getInvoiceRegister({asOfDate, customerId?, status?, limit?, cursor?})`
returns one bounded page, a financial revision and whole-customer-scope summary
in one SQL snapshot. Limit defaults to 50 and is at most 200. Rows contain SDK
invoice identity/status/version, terms memo and classified current settlement;
no commercial line or receipt history is loaded into the application.

`status` accepts draft/open/overdue/paid/voided, `active` (all except voided),
or `receivable` (posted nonvoid invoices, including settled invoices). Open
combines open/sent/partial. Summary counts include every status in the selected
customer scope, independently of the page filter; `all` includes voided. Counts
are decimal integer strings. Outstanding and overdue exclude drafts and voids;
draft amount includes only live drafts. `basis: current` is explicit: asOfDate
selects overdue labels and does not reconstruct historical balances or exclude
future-dated documents. Use historical statements/aging for historical reports.

Continuation requires the original explicit asOfDate. Cursor scope binds
company/tenant/book/customer/filter and financial revision. Reload the first
page and summary together on optimistic_concurrency_conflict. Source revisions
invalidate conservatively, including unrelated changes in included sources.
Schema42 adds statement triggers for invoice draft lines and delivery events;
rollback and no-op updates do not invalidate. Book activity/currency/basis are
rechecked in the same statement as the returned page and totals.

The old listInvoices API retains its response contract. This API bounds client
memory and removes detail/receipt fanout; it does not by itself prove million-row
latency. Global counts still scan the scoped register in PostgreSQL. BLU must
replace its global client reductions and uninvoiced-order inference before
adopting register pages. Operational order eligibility must not infer absence
from a selected invoice page, and gross invoice economics must not be inferred
from an order's remaining collection balance.

High posting rates can invalidate continuation frequently because the revision
is source-wide. Sustained concurrent-posting benchmarks must measure restart
frequency as well as latency before launch; bounded memory alone is insufficient.
Schema42 changes trigger definitions without rewriting existing financial rows,
but DDL lock duration still needs measurement on representative deployment data.

### Explicit invoice tax and discount accounts (schema 43, candidate 0.3.132)

Invoice and credit commercial lines accept optional `taxAccount` and
`discountAccount` references (`{accountId}` or `{accountKey}`). With these
references, `amount` remains the net customer-facing line amount. The journal
credits gross revenue, credits tax liability, and debits the discount account;
AR is the net invoice amount. The existing exact decimal arithmetic contract
still requires quantity × unit amount − discount + tax = amount.

`invoiceAccountPolicy` additionally accepts `taxClassifications` and
`discountClassifications`. Configuring either list requires its explicit account
when that component is positive. Explicit tax accounts default to liability and
explicit discount accounts default to income/other_income when lists are omitted.
They must be active, scoped, and distinct from the receivable control account.
Account checks run under the existing transaction locks. Missing references retain
historical net-revenue behavior for other consumers unless their policy opts in;
this is compatibility, not an acceptable BLU configuration for new taxed sales.
Identical historical retries retain their original receipt and do not repost under
a newer policy. Changed component references conflict.

Schema 43 adds nullable component account identities and scoped foreign keys to
invoice draft and posted commercial lines. It does not infer accounts or rewrite
historical amounts. Draft reads and posted invoice lines expose `taxAccountId`
and `discountAccountId`. Draft issuance, cancellation, and replacement preserve
the component identities. Hosts must migrate before running the new writers.

Cash projections for new explicit-component invoices use the net AR control,
allocate against the remaining original posting components, and reverse exact
saved allocations. This prevents cumulative rounding drift at final settlement
and preserves component amounts through unapply/reapply. The bounded SQL aggregate
returns one row per original posting, not the application history. Its large-data
query plan and source-lock throughput still require the goal's scale measurements.

Use `customerPayments.previewReturnCash` / `returnCash` with an explicit release
plan to return recorded money without cancelling a sale. Preflight models the
pending release before evaluating the residual allocation. The older generic
`refunds.issue({relatedInvoiceId})` cash-basis reversal does not identify which
receipt allocation is being returned; it fails with `unsupported_operation` for
new explicit-component invoices. Historical invoices without component identities
retain their existing API behavior. Hosts must route cash returns through the
receipt API and sale adjustments through explicit credit/correction commands.
Zero-total invoices and zero-value commercial lines remain unsupported in this
candidate and are outstanding BLU launch-policy/implementation work.

This SDK change alone does not remove BLU's temporary tax/discount gate. BLU must
supply reconciled component amounts, map its tax and discount accounts, configure
the strict policy, preserve old command payloads on replay, and pass the existing
payment-method test with its unchanged taxed/discounted order economics before
that gate can be removed. Installed SDK pins, production schema/data, and release
status have not changed as part of this candidate work.


### Bounded historical aging (0.3.133)

`queries.getAgingPage({kind, asOfDate, limit?, cursor?})` returns 1–200 party
rows per page (default50), all-scope totals, decimal-string `partyCount`, and a
financial `revision`. Use `limit:1` when only totals are needed; never total the
page to produce a report. The database computes totals in the same statement as
page rows and revision. Sort order is party ID ascending. Continuation requires
identical kind/cutoff/tenant/company/book; committed accounting or book-source
changes invalidate it with `optimistic_concurrency_conflict`. Restart at page1.

AR retains the existing historical **net** aging contract: unapplied receipts
and credits are negative offsets, aged by their document date. AP remains gross
unpaid bills. Both preserve the existing exclusion of zero-net parties. These
are not interchangeable with current gross invoice-register balances. Label
net aging and gross invoice due separately; do not synthesize either from local
order/payment balances. The existing unpaged `getAging` API remains compatible
for consumers; BLU's growing-ledger surfaces should use the bounded API.

This change bounds application response memory; it does not establish million-
entry database performance. Historical application reconstruction, grouped SQL
work, query plans, latency and concurrent-posting contention still require
representative isolated measurement. Party names are current display metadata;
the continuation revision covers financial facts and book scope.

`getInvoiceRegister().summary.averageOpenAgeDays` is the rounded, unweighted
mean age of current open/overdue invoices from document date through the label
cutoff, clamped at zero for future document dates. Empty scopes return `"0"`.
It is computed with the whole-scope register totals, never from a page.

### Receivables read scaling (0.3.134)

AR aging reconstructs effective application sides once per report, then joins
those grouped amounts to documents. This replaces per-document lateral event
reconstruction without changing historical cutoff, provider-snapshot, receipt
return, credit, reversal, source-window, or zero-net-party rules. Both paged and
compatibility aging APIs share the same calculation. No schema migration or
host-side financial cache is introduced.

`test/receivables-scale.postgres.test.ts` is an opt-in disposable PostgreSQL
measurement. Run through `scripts/test-ephemeral-postgres.mjs` with
`ERP_FINANCIALS_RUN_SCALE_TESTS=1`; `ERP_FINANCIALS_SCALE_INVOICES` defaults to
1,000,000 (10,000 minimum for rehearsal). It uses the latest schema with guards
and constraints enabled, 10,000 customers, 243 document dates, one receipt per
four invoices, and partial applications five days later. Independent integer
controls check historical buckets, current gross invoices, balanced GL totals,
and account balances. Public native invoice commands run concurrently with
paged reads; committed changes invalidate earlier continuations. Output includes
query plans, workload and hardware, latency, lock samples, Node memory, and
sampled PostgreSQL process-tree PSS/RSS. The fixture is synthetic and does not
establish production capacity, a soak result, or full lifecycle coverage.

### Invoice register presentation scaling (0.3.135)

`getInvoiceRegister` calculates financial status, filters, counts and money
without joining customer display names or latest delivery attempts across the
whole ledger. It enriches only the bounded page with those presentation fields.
The register's broad `open` status still includes fully open, sent and partially
paid invoices. Item status retains the existing precedence: voided, paid,
overdue, partial, sent, open. A later failed delivery changes a fully open item's
presentation back to open; it does not change its financial balance or register
category. Names remain current display metadata, not historical ledger facts.

Summary, page and revision still come from one SQL snapshot. The private shared
invoice SQL builder keeps the existing `listInvoices` API behavior intact. No
schema migration, financial cache, new accounting authority or public response
change is introduced. The scale fixture now includes two immutable delivery
attempts on every fifth invoice (400,000 events at one million invoices), checks
page statuses against an independent oracle, and asserts from PostgreSQL's
executed plan that delivery-event scan loops do not exceed the page lookahead.
This is a query-plan check, not a production latency guarantee.

### Native bill cash-flow allocation (0.3.138)

`queries.getCashFlowSummary` attributes a fully applied native bill payment to
its vendor bills' economic accounts, using the SDK's exact cash-basis application
postings and their deterministic cent allocation. The same attribution applies
to accrual and cash reports. A blanket role on the shared payable control account
does not override this evidence. A mixed equipment/supplies payment therefore
splits investing and operating cash without a BLU allocation formula.

A linked native payment void reverses those same allocations, including a void
in a later reporting period. Reports ending before a later unapplication or void
retain the earlier application state. Missing policy, incomplete application
coverage, missing or invalid allocation evidence, and a plain unapplication with
no linked cash reversal produce `supportStatus: "partial"`; the host must not
publish a complete cash-flow statement from that result. Zero net unclassified
cash does not establish completeness; inspect the support status and counts.

This does not yet attribute customer receipts/refunds, unapplied vendor advances,
or arbitrary imported control-account cash to underlying economic documents.
A later noncash reallocation can make a wider as-of report partial even when an
earlier month was supported. This is an explicit unresolved case, not permission
to classify every AR/AP movement as operating or to synchronize a second ledger.
The query remains one database snapshot returning one bounded summary row;
large native-payment workloads require separate scale validation.

### Receipt cash-flow purpose (0.3.139)

`commands.customerPayments.record` and `recordAndApply` accept optional
`cashFlowActivity: "operating" | "investing" | "financing"`. This is the explicit
economic purpose of the cash, not an invoice status or a mutable balance. It is
retained in SDK document metadata, compared on exact replay, and exposed by
`queries.getCustomerPayment`. Omit it when the purpose is not established;
never infer it from a shared receivable account. Existing command payloads remain
replayable without the new field; supplying a different purpose on retry conflicts.

The direct cash-flow summary uses this purpose for the receipt and for native
`customerPayments.returnCash` refunds or captured-payment voids linked to it.
Later applications, partial application releases, and noncash credits do not
reclassify earlier cash. Missing/invalid purpose or inconsistent cash evidence is
partial, including old native receipts even if the report assigns a blanket AR
role. Migrated receipts therefore need verified purpose evidence before cash-flow
reporting is complete; this change does not silently backfill old documents.

BLU's order-collection entry points explicitly supply operating purpose: they
collect for operational customer orders whose sales account policy requires income
accounts. They do not classify arbitrary asset-disposal or financing receipts.
This is an explicit repository policy, not a claimed owner Coverage answer. Validate
it against actual source transactions before cutover. BLU uses the SDK's public
receipt detail to preserve older accepted payloads on retry. No SDK table reads,
local accounting classification ledger, or bidirectional synchronization is needed.

Cash-flow reads reject ambiguous native document ownership rather than multiplying
cash totals through a duplicate join. The returned categories must reconcile
exactly to net cash movement and opening/closing cash, using integer cents. These
checks are additional validation, not a repair or a substitute for migration
ownership reconciliation.

### Bill cash-flow history and reallocation (0.3.140)

Bill-payment cash-flow purpose now comes from the immutable cleared instruction,
its accepted original application identities, and the exact original cash-basis
allocation postings. The instruction's cleared lifecycle receipt must agree with
its amount, allocation list and original payment transaction. Later unapplication
or reassignment moves no cash and does not reclassify that earlier payment. A
cash void reverses the original purpose, even if the current bill application is
different. Individual months and their combined window therefore agree under
an unchanged reporting-account policy.

This fixes a reproduced 0.3.138–139 defect: paying an operating bill in August
and assigning the payment to an equipment bill in September left August showing
operating cash but changed the combined window to investing cash. Both accounting
bases reproduced the mismatch. The regression also covers subsequent compensation.

Raw/imported bill payments without provable cleared-instruction evidence remain
partial. This does not establish a migration or correction policy for previously
misclassified cash. Correcting the economic purpose itself needs an explicit,
audited SDK correction with appropriate fiscal-period controls; ordinary payable
reassignment must not be used as an implicit historical cash restatement. That
correction/migration surface remains required before full launch acceptance.

### Explicit cash-purpose restatement (0.3.141 / schema 44)

The SDK now owns `commands.cashFlow.correctPurpose` and
`queries.getCashFlowPurpose`. This is an explicit reviewed correction, separate
from ordinary bill reassignment. It preserves initial receipt idempotency
metadata and original clearing instructions. The current purpose is an immutable
SDK revision, not a BLU balance or account table. Both accounting bases and native
refund/void cash movements use it. Receipt corrections use one purpose; bill
payments accept exact mixed amounts summing to the original payment.

Every original/return/void cash period must be open; fiscal locks and concurrent
close take precedence. Source revisions invalidate pending close approvals even
though GL amounts stay unchanged. The host must obtain actual authorization and
approval for the correction, then regenerate/reclose affected reports. This API
does not retroactively correct operational bills, perform gateway movements,
or silently repair imported history. BLU correction UI/workflow adoption,
production migration/reconciliation, and million-entry measurements remain
separate completion requirements. Version 141 is a local candidate until Git
publication, full-SHA pin, installation and release verification complete.

The administrator-direct approval wrapper also encloses confirmation evidence and
command execution in a savepoint. A host-caught failure cannot commit a stray
administrator-confirmed event; the PostgreSQL regression injects an outbox
failure after cash-purpose evidence and commits the surrounding host transaction.

### Cash-flow scale validation (0.3.142 / schema 45)

Cash summaries accept PostgreSQL `numeric` text with extra zero-only scale
(e.g. `100.010000`), normalize it to cents without floating point, and still
reject sub-cent facts. Schema 45 adds a nonunique scoped transaction/document
lookup index. The report continues to reject ambiguous native ownership;
indexing does not deduplicate or change financial records. The additive index
migration is transactional and takes a write-blocking table lock while building.
Plan that operation in the bounded, approved cutover window with backup and
rollback evidence; do not treat it as a lock-free live change.

The opt-in `test/cash-flow-scale.postgres.test.ts` uses the disposable PostgreSQL
harness. Set `ERP_FINANCIALS_RUN_SCALE_TESTS=1`; the default is one million
invoices plus 250,000 receipts/applications, 1,000 mixed-purpose native bills and
partial payments, corrections, voids and refunds. Smaller smoke runs can set
`ERP_FINANCIALS_SCALE_INVOICES=10000` and `ERP_FINANCIALS_SCALE_BILLS=20`.
The test compares summaries with a separate integer fixture oracle for full and
partial periods, records query plans and hardware, and checks same-snapshot
cash/category/count agreement during four concurrent writers and four readers.
The output reports Node RSS and sampled PostgreSQL PSS as well as latency and
throughput. The bulk history is direct synthetic fixture insertion with normal
constraints/triggers; it is not a million public API calls, a production sizing
promise, a sustained soak or a migration rehearsal. Actual measurements belong
in the consuming project's evidence, with their exact source commit and limits.

### Cash-flow predicate pushdown (0.3.143 / schema 45)

The SDK cash-flow query permits PostgreSQL to inline scoped postings so report
window and native-document predicates reach the base relation. Opening and
ending cash and historical precision validation share one aggregate pass;
prior-period noncash fractional-cent facts still invalidate the report. All
categories, ownership checks and balances remain in the same SQL snapshot.
There is no schema change, cached balance authority or relaxed precision rule.

A 100,000-invoice disposable test and the focused PostgreSQL cash-flow regression
suite passed during development. Those results do not establish million-entry
or production performance; record the final measurements, hardware, concurrent
workload and source commit with the consuming project's release evidence.

### SDK reporting calendar (0.3.144 / schema 45)

`queries.getReportingCalendar({ sourceId, year })` returns twelve calendar-month
coverage summaries and the intersecting canonical fiscal-period identities,
dates, statuses, versions and available close-certificate references. It reads
the book, source membership and fiscal metadata in one SQL snapshot. Calendar
year is a date window, not a fiscal-year label; fiscal periods may cross months
or calendar years. Effective source membership bounds coverage.

A fully covered month with one fiscal status is open, closing or closed.
Different fiscal states produce mixed; any uncovered day produces unconfigured.
No unavailable or missing calendar is represented as closed or open. The read
rejects overlapping periods and uses a 367-row sentinel: at most 366 nonempty,
nonoverlapping periods can intersect one calendar year. This bound applies to
configuration metadata, not a growing ledger, and does not truncate history.

These are read-time presentation facts and a deterministic revision, never
posting or close/reopen authorization. Those commands still enforce current
SDK lifecycle locks. BLU's report month selector and forecast display must use
this projection; legacy fiscal-period records, reopening flags or cached local
closure decisions must not supply accounting authority. Operational forecasts
may remain operational estimates, but must never be labeled posted actuals.

### Coherent financial statements (0.3.145 / schema 45)

`queries.getFinancialStatement` now reads book configuration, mapped account
balances, defined hierarchy and derived earnings in one SQL statement. Under
READ COMMITTED, the former sequence could read assets before a concurrent
posting and earnings after it, falsely reporting an unbalanced balance sheet.

`queries.getFinancialStatements({ statements: [...] })` applies that same
snapshot to an ordered batch of one to 36 requested statement windows. This
bounded request size supports twelve months of three statement types; it is not
a ledger-row limit and never silently truncates results. Each window retains
its report name, dates, as-of cutoff and optional accounting method. Inputs are
captured before database acquisition. Numeric amounts are serialized as text
inside SQL JSON so JavaScript parsing cannot round large exact amounts.

BLU must use the batch for annual/monthly comparison responses rather than
fan out independent statement reads. The SDK does not change an enclosing host
transaction's isolation, acquire writer locks or expose internal tables. A
single statement and a batch are coherent at their read snapshot; independently
requested responses still represent potentially different points in time.

This fixes consistency, not a proof of production-scale latency. Re-measure
representative wide batches with actual account cardinality and posting volume.

### Historical dashboard contract (0.3.146)

Dashboard receivables/payables are **gross open invoices/bills**, reconstructed at
`asOfDate` from effective applications, releases and corrections. Future documents
and later settlements cannot change an earlier date's balance. Draft invoices are
excluded. AR aging additionally nets unapplied receipts and credits; its net total
can legitimately differ from gross dashboard receivables. Customer-statement
outstanding invoices provide the matching gross control. These obligation KPIs
remain document-based when the ledger accounting basis is overridden to cash. Overdue uses contractual
`due_date < asOfDate`; a missing due date does not become an overdue obligation.
Provider-owned QuickBooks snapshots retain the existing historical-reader fallback
when the provider supplies a current balance without full application history;
this does not certify history the provider never supplied.

The dashboard preserves its public response shape. Book-mapped account
classifications and all retained/current earnings now agree with financial
statements. The public mapping API already enforces matching source/book
classifications; the previous source-classification read alone is not evidence of
an independently reproducible classification defect. All configuration, ledger
and subledger amounts share one PostgreSQL statement snapshot without changing a
host transaction's isolation or acquiring writer locks. BLU must require this
validated SDK version rather than calculate historical balances locally.

### Statement history aggregation (0.3.147)

A statement batch reduces scoped posting history once into disjoint date bands
built from every requested start and inclusive end. Account, source, currency and
accounting-basis identities remain separate; each report is derived from the
same exact numeric aggregates in the same SQL snapshot. Arbitrary daily and
overlapping windows are preserved; these are not monthly approximations or a
persisted second ledger. Validated global date bounds are passed as parameters
so PostgreSQL can estimate their selectivity from column statistics.

This change does not establish a production latency guarantee. The benchmark
records independent exact controls, concurrent posting and query plans; release
acceptance still requires the representative workload and deployed resources.
