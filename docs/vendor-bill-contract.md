# Vendor bill public contract

Version `0.3.1` adds the Bills and Bill detail contract to both public package
entry points. No private ERP Financials table access is required.

## Read surface

Use `sdk.queries` (or `createFinancialReadModels(...)`) for:

- `getVendorBillRegister({ limit, cursor, status, asOfDate, vendorId })` (0.3.83+)
- `listVendorBills({ limit, cursor, status, asOfDate, vendorId })`
- `getVendorBill(billId, asOfDate?)`
- `getVendorBillSummary({ asOfDate, periodStart?, periodEnd?, vendorId? })`

The detail result identifies the canonical bill and posting source, returns the
vendor and commercial header, and includes immutable lines and bill-payment
applications. The summary returns as-of balances plus cumulative and selected-period
payment KPIs; the period defaults to the month containing `asOfDate`. Each line reports its canonical account, source account key,
optional reporting-book mapping, and item expense-category provenance.

## Correction surface

New native bills remain posted by `sdk.commands.vendorBills.create(...)`.
Posted facts are never edited or deleted. Correct an unapplied bill with:

- `sdk.commands.vendorBills.voidIssued(...)`
- `sdk.commands.vendorBills.replaceIssued(...)`

The equivalent `voidPosted(...)` and `replacePosted(...)` aliases are retained
for hosts that describe this lifecycle in posting terminology.

Both commands require an independently approved operation context, an
idempotency key, and the current `expectedVersion`. A bill with any active
application must be unapplied first. Replacement preserves the original vendor
and currency and records linked reversal/replacement journals.

## Paged operational register (0.3.83)

`getVendorBillRegister` returns at most 200 lightweight rows plus exact global
summary amounts and counts. Page rows and summary share one PostgreSQL statement
snapshot. It does not fetch bill lines, payment instructions, or ledger postings.
Use `getVendorBill` and `listVendorBillAudit` only when opening an individual bill.

Rows sort by ascending due date then canonical bill ID. Supply `nextCursor` to get
the next page; retain the returned `summary.asOfDate` across pages. Cursors are
bound to tenant, company, book, as-of date, vendor and status. A changed filter
starts a new pagination sequence. Separate requests observe new commits; this is
not a frozen multi-page export. Refresh from the first page after a mutation.

The register facets are mutually exclusive: `voided`, `replaced`, `paid`, then
`on_hold`, `overdue`, or `open` (including partially applied bills not yet overdue).
A payment hold is a current operational restriction, not a historical accounting
balance. Versions and hold fields remain current even when querying historical
amounts. Obtain current versions again when submitting a command.

Summary totals and counts cover the entire book/vendor/date selection, independent
of the selected facet and cursor. `overdueAmount` includes held overdue bills;
`dueSoonAmount` includes held bills due from `asOfDate` through seven days later,
inclusive. `counts.overdue` excludes held bills because facets are exclusive.
`outstandingBillCount` counts all positive outstanding liabilities. All amounts
and counts are decimal strings: do not convert aggregate cents to JavaScript
`number`. `appliedAmount` includes payment and credit applications. A correction
that reduces an open balance to zero does **not** count as a payment/application.

The query reuses the SDK's existing bill as-of calculation, including imported
provider balance evidence. It does not create another balance model in a host.
Historical accuracy still depends on imported evidence completeness. The database
aggregates the scoped register for global totals; this API by itself is not proof
of million-entry performance. Measure the deployed database and representative
application/correction distributions before making a scale claim.

## Consumer upgrade and recheck

Install a published full commit SHA from the public HTTPS Git repository and
commit the matching package-manager lockfile:

```bash
npm install --save-exact 'git+https://github.com/c0x65o/handrail-sdk-erp-financials-js.git#<full-40-character-commit-SHA>'
npm ls @handrail/erp-financials
npx tsc --noEmit
```

Resolve the published SHA for the intended version before installation. Keep SDK
compilation in the normal install/build pipeline. Do not replace the dependency
with a local path, tarball, registry package, branch, or tag. A candidate-source
loader is suitable for isolated development tests, not release evidence.

Recheck the Bills register through the public query and Bill detail through
`getVendorBill`; do not retain fallback queries over private SDK tables. The
additive register API does not change `listVendorBills` sorting or its existing
status vocabulary. Version 0.3.83 requires no schema change beyond schema 33.

## Correction retry safety (0.3.107)

Posted bill void/replacement commands snapshot the complete invocation before
waiting for a transaction. Callers cannot change the version, date, actor or
replacement lines of an in-flight command by mutating its input object.

An independent-approval retry must keep the original expected version, actor,
approver, reason and economic payload. A fresh transport request ID, correlation
ID or request timestamp is allowed; the original immutable audit event retains
its original metadata. Changed versions or business inputs fail with an
idempotency conflict and leave postings, lifecycle events and outbox unchanged.
This also applies to bill corrections already recorded before this version:
the terminal original bill preserves its pre-correction version plus one.

Administrator-direct commands continue to require their exact server-validated
confirmation and command checksum. This release does not relax that approval
contract or make a new transport request a substitute for confirmation.

The generic lifecycle append API remains strict by default. Its explicit
`allowTransportReplay` option is for commands that have already validated their
business idempotency; it never relaxes actor, approver, reason, aggregate, prior
event or payload checks. No schema migration is required (schema 38).


## Correction scope and previously applied bills (0.3.108)

Void and replacement validate the original `ledger.posted` outbox evidence before
any write or retry receipt. Its tenant, company, source and posting book must
match the command scope, including an explicitly unbooked original. A different
book bound to the same source does not authorize a correction. Missing or
ambiguous original posting provenance fails with `scope_mismatch`; a host must
resolve that evidence through a reviewed migration, not bypass the check.
Original currency must still match the single-currency command scope.

Native vendor bills post their liability on the accrual basis. Applications may
add cash-recognition postings associated with the original bill transaction.
Correction reverses only the original accrual posting. Active partial or full
applications still block void/replacement. After an authorized unapplication,
correction can proceed with the new current bill version; it does not reverse
cash recognition a second time, delete payment evidence, void the cash payment,
or automatically apply the available payment to the replacement bill. The host
must explicitly authorize any subsequent reapplication or cash reversal.

This fixes cross-book correction acceptance and the mixed-basis error encountered
when correcting a previously applied bill. It adds no public API or schema change
(schema 38). Bill-payment and adjustment correction paths require their own
lifecycle validation; this vendor-bill fix does not establish their correctness.


## Correction transaction and lock boundaries (0.3.109)

A posted bill void/replacement is enclosed in a PostgreSQL savepoint. When a
host binds the SDK to an existing transaction and catches an error, the command
rolls back its complete reversal, bill transition, replacement, lifecycle and
outbox changes. Earlier host work remains intact. An autocommit client cannot run
this command: establishing the savepoint fails before financial writes. A retry
uses the original immutable command and expected version.

Correction, payment-hold changes and immediate `recordAndApply` acquire the
existing source correction lock before bill rows. This removes the reproduced
lock inversion with generic applications and these AP writers; stale commands
then reject against the committed version instead of entering a deadlock cycle.
It uses the existing source-wide serialization boundary, not a new parallel
posting guarantee. Scheduled-payment clear/cancel/compensation, other document
writers and transactions taking host locks before SDK locks still require their
own concurrency validation. No broad throughput or all-command lock-order claim
is implied by these tests.

Real PostgreSQL tests cover both completed-command winner orders for void and
replacement against payment, interrupted commands at reversal-link, original
bill, replacement, lifecycle and outbox writes, a database SQL error, caught
validation failure, and in-flight application/hold/immediate-payment contention.
These tests preserve cash evidence, restore exact pre-command SDK table state
on failure and verify retry without additional facts. This is not yet an atomic
unapply/replace/reapply public workflow. Active applications continue to require
explicit authorized handling. There is no API or schema migration (schema 38).

## Atomic applied-bill correction (0.3.110)

`commands.vendorBills.correctPosted` is the SDK-owned transaction for correcting
an applied native bill. Existing void/replace methods retain their requirement
to unapply first. A host must authorize the complete correction before calling
this command; application releases are not payment refunds or cancellations.

The command includes the original bill ID/version, a stable idempotency key,
correction date, independent approval context (or explicitly configured
`vendorBills.correctPosted` administrator confirmation), and an explicit release
plan. Each release identifies an active application, its reviewed version, its
source payment/credit's reviewed version, and an exact `reapplyAmount`. The plan
must include every active application on the bill exactly once. Repeated sources
use the same pre-command source version. Input array order does not affect replay.

Omit `replacement` to void the bill and leave all released amounts available;
all reapplication amounts must then be zero. Supply replacement bill fields to
reverse and replace it. The SDK derives the replacement and application keys.
Reapplication is explicit and may use available source funds up to the replacement
balance; excess remains unapplied. No payment is recorded, refunded, or voided.
The correction date cannot precede a released application or the replacement's
date. Existing posting-period policy applies. Native source posting evidence
must match the vendor, currency and book. Imported or ambiguous payment/credit
provenance fails closed and requires separate reviewed handling.

A held bill's replacement retains its hold and reason. A held bill correction
cannot reapply funds; release the hold through its separate authorized command
before reviewing a plan that makes new applications. The ordinary legacy-shaped
`replacePosted` path's hold treatment is not changed by this additive API.

The source lock, savepoint, releases, accrual reversal/replacement, new applications,
completion receipt and outbox share one transaction. Failure rolls the complete
command back even if a host catches the error inside its transaction. The receipt
binds scope, versions, plan, replacement, actor, approver and reason. Independent
approval retries may use fresh transport metadata; they preserve the original
audit. Administrator-direct retries retain the existing exact-confirmation
contract. A separately created document using the derived replacement key is not
accepted as a completed correction.

`CorrectPostedVendorBillResult` is an immutable completion receipt. Its nested
creation result and `replacementPosition` describe the correction when committed,
not current balances after later payments or corrections. Read current bill and
payment state through public SDK queries. Replaying a completed command after
later application changes or fiscal close returns the original receipt and adds
no financial facts.

Tests cover partial/full cash, zero/partial reapplication, multiple releases from
one source, holds, approval, wrong scope, changed retries, concurrent commands,
failures at each stage and an actual terminated PostgreSQL connection followed by
retry. Bill register/aging gross liability reconciles to the AP control account
by subtracting unapplied payment balances; those values must not be conflated.
This does not provide the host's approval UI, canonical replacement-link mapping,
provider correction workflow, or launch migration. Schema remains 38.

## Bounded correction review (0.3.111)

`queries.getVendorBillCorrectionReview({ sourceId, billId, limit?, cursor? })`
provides current native evidence for composing `correctPosted`. Each page returns
the bill version, amounts, vendor, dates and hold; the total active application
count and applied amount; and up to 200 active application rows (default 50).
Rows include application version, source document ID/type/version, source original
and open amounts, application date and amount. Repeated sources repeat their
balances; these are per-source values, not amounts to add across rows.

Header, source versions, controls and page come from one SQL statement snapshot.
The query is restricted to this bill's active applications through the existing
target/status index. It does not collect ended application history or ledger
postings, and does not issue per-row detail queries. PostgreSQL computes the
freshness digest over the active evidence; only the bounded page crosses into
application memory. This is not a million-entry benchmark or an authorization
lease.

The cursor binds tenant, company, book, source and bill plus a `reviewToken` for
the entire active plan. A changed bill/hold or active source payment/credit version
invalidates the next page with `optimistic_concurrency_conflict`, including a source
payment changing through another bill. Restart review from page one. Unrelated
postings do not invalidate it. A wrong scope or malformed cursor is rejected.
Native posting provenance must match the book; ambiguous/imported source evidence
fails closed. Voided bills cannot start another correction review.

The token detects freshness; it is not permission, an approval signature, or a
substitute for command version checks. Hosts must collect/review a complete plan,
persist immutable approved intent and pass the reviewed versions to `correctPosted`.
That command independently validates the complete current plan under locks. No
private SDK table reads or per-payment detail fanout are required to obtain these
versions. The host's independent approval and replacement-link workflow remain
separate implementation work. This is a current operational review, not an as-of
aging report. There is no schema migration (schema 38).

## Historical payable aging (0.3.113)

`queries.getAging({kind: "payables", asOfDate})` now uses the same effective-date
bill balances as the vendor bill register. A subsequent payment, release,
replacement or void no longer erases the original bill's earlier outstanding
amount. Application start/end evidence and reversal transaction dates determine
that day's position; due dates determine its aging bucket. Book source membership,
source effective ranges and currency remain enforced.

The result remains **gross unpaid bills**. Available vendor payments/credits are
not silently netted into its buckets. Reconcile gross unpaid bills less unapplied
vendor payments/credits to the AP control account. No schema or return-shape
change is required. The existing imported-bill evidence rules are shared with
the register; this change does not manufacture missing imported history.

This fixes the reproduced BLU correction case: a $100.01 bill with $40.00 applied
corrected on Aug24 to $90.01 with $30.01 reapplied must still show $60.01 for Aug23,
while Aug24 shows $60.00. Prior aging used the current voided original and omitted
the not-yet-effective replacement, returning $0.00 for Aug23.

This patch does not change receivables aging semantics or add party pagination;
those remain separate host rollout/scale work. It does not change replacement
recognition dates: the supplied reversal and replacement dates remain distinct
posting dates and must be reviewed by the host as such.

## Bill payment book ownership and lock order (0.3.114)

Scheduling, scheduling retries, clearing, cancellation and compensation now check
original book ownership. Company/source membership alone is insufficient: the
same source can participate in several books. An instruction's retained
`bill_payment.scheduled` evidence supplies its book before a cash journal exists;
posted payment voids use the original native posting evidence. New instructions
also validate all target bills' native posting books in one batch query. A missing
or different book attribution rejects with `scope_mismatch` before accounting
changes. This applies to legacy callers without a configured book too: an absent
book must match original absent-book evidence, not act as a wildcard.

This closes reproduced cross-book scheduling retry, clearing, cancellation,
compensation and raw posted-payment void defects. It intentionally fails closed
for imported documents or older data without native posting/scheduling evidence;
do not manufacture ownership from a requested report book. Consumers needing to
settle imported provider bills must verify their supported provider/import
workflow separately. Preserve the original outbox provenance when archiving;
publishing an event is not permission to erase accounting ownership evidence.

Bill payment lifecycle writers acquire the existing source correction lock before
instruction, bill or application row locks. This fixes a reproduced PostgreSQL
`40P01` deadlock between scheduled clearing and bill correction. Real PostgreSQL
race tests cover clear/correction and compensation/correction with actual lock
waits and stale-version rejection. This lock is shared across the source and may
limit concurrent throughput; these correctness tests are not scale measurements.

Public input/result shapes and schema 38 remain unchanged. This patch does not
claim completion of cancellation/compensation transport replay, command snapshot,
closed-period recovery or every mixed legacy/imported workflow. Those require
separate acceptance evidence before a host rollout.

## Payment command recovery boundaries (0.3.115)

Cancellation, compensation and posted-payment void snapshot the command before
waiting for a transaction, while preserving only a live SDK-issued administrator
confirmation capability. Independent-mode callers cannot change the target,
actor, date or key after validation by mutating their original object.

Scheduled cancellation retries compare the original command key and immutable
actor/approver/reason, accept fresh transport request/correlation/time fields,
and return the original cancellation event/version without writing. Changed
authorization still fails. Compensation and raw void transport replay are a
separate audit; this change does not declare them verified.

Scheduling, immediate record-and-apply, clearing, cancellation, compensation and
posted-payment void each establish a PostgreSQL savepoint inside their enclosing
transaction. If a host catches a command failure, the SDK rolls back the whole
failed command, including audit/outbox, while retaining earlier host work. A
runner must supply a real transaction: autocommit is not a supported substitute.
Nested payment operations retain the enclosing command's rollback boundary.

Real PostgreSQL tests inject an error after the final outbox write for each of
these six commands, catch it in the outer host transaction and commit. Complete
SDK storage remains unchanged; an identical retry succeeds. Separate tests cover
independent-mode input mutation and administrator confirmation/audit propagation.
No schema or public input/result shape changes are required (schema 38).

## Void and compensation completion receipts (0.3.116)

New posted-payment voids and compensations retain an immutable SDK lifecycle
completion receipt in the same transaction/savepoint as the reversal. Its
checksum binds the action, payment, original expected version, date, memo,
accounting scope and actor/approver/reason. Request/correlation/time metadata may
change on a transport retry; a changed business command or authorization fails.
Retries read the original result without calling posting/application writers,
including after fiscal close. Reversal retry status remains `already_posted`
with zero write counts; the outer status remains `already_voided`. Public
input/result shapes and schema 38 are unchanged.

The outer compensation receipt matters for raw payments as well as scheduled
instructions: releasing applications advances the source payment version. The
terminal version alone cannot prove the originally reviewed outer version.
Late receipt-write failures roll back the entire command, even if the host
catches the error; concurrent identical commands return one completion.

Compatibility with pre-receipt history is explicit. A raw void can be replayed
read-only from retained primary/mirror journals, original book provenance,
lifecycle events and the void link. A disbursement-backed compensation also
validates the original disbursement version and authorization before reading
that reversal. Neither path recreates missing evidence. Raw compensated payments
without a disbursement or outer completion receipt fail closed: their original
outer expected version is not durably provable from the existing contract.
Before rollout, inventory such history and reconcile its original command and
retained audit evidence through an approved recovery procedure; do not invent a
receipt or run the money movement again. This patch does not supply that
migration/recovery procedure or claim historical rollout readiness.

PostgreSQL tests cover changed payload/authorization, fresh transport retries,
closed-period read-only replay, caught failure after the final completion write,
concurrent retries and immutable receipt deletion guards. Legacy compatibility
tests hide only the new completion reads over otherwise real retained records;
they are not a production-history migration rehearsal.

## Reviewed payment corrections (0.3.117)

`queries.getBillPaymentCorrectionReview({sourceId,paymentId,limit,cursor})`
returns a scoped native payment header, exact active application count/amount,
and a bounded page of active applications with target bill versions and holds.
Scheduled payments have no posted document or active applications. Their amount,
reference and funding/payable account identities remain available for reviewing
cancellation. The API does not execute a bank transfer or cancel one.

One SQL snapshot reads the payment, active application controls and page. It
never collects ended application history or calls one detail query per row.
The review token binds the payment/disbursement/document state and every active
bill/application revision, not just the current page. Pagination rejects a stale
or foreign cursor. Only native ownership evidence in the selected active book
and source window is accepted; imported/missing evidence fails closed.

`billPayments.voidAndUnapply` accepts optional `expectedReviewToken`. A host that
uses human-reviewed compensation must freeze and require this token. The SDK
rechecks it after acquiring its source/payment locks and before accounting
writes. This is necessary because a disbursement's version does not advance
when a separate application is released or moved. Bill changes (including
holds) also invalidate the review. A newly reviewed compensation may release a
held bill's application; it does not clear that bill's hold or cancel the bill.
Existing consumers omitting the token retain their existing full-payment
compensation contract. The token is a concurrency precondition, never an
approval credential. Actor/approver validation still applies.

The successful outer completion receipt binds the token. An exact retry returns
that receipt before checking current reviewability, including after fiscal
close; changing the token conflicts. No schema migration is required. BLU must
still wire the required token, approval intent, command and operator recovery
workflow before claiming this capability complete in the application.

## Overdue vendor bill recognition (0.3.118, schema 39)

A vendor bill's contractual due date may precede its recognition date. This is
needed when a late bill is entered or an overdue bill is corrected in a later
open period. `vendorBills.create`, `replacePosted`, and `correctPosted` retain
that due date without extending payment terms. Invoice date rules are unchanged.
Migration 39 relaxes only the vendor-bill branch of the subledger due-date check;
it rewrites no documents, journals, applications, or historical evidence. The
normal transaction and native posting-period checks still apply.

The SDK continues to honor distinct reversal and replacement dates. Hosts that
intend a correction effective on one date must supply that same date for both
entries. The BLU correction workflow enforces that single-date policy. For
example, an Aug1 $100 bill with $40 paid on Aug10, corrected on Aug12 to $90 with
$30.01 reapplied, retains $60 outstanding at Aug11 and $59.99 gross outstanding
at Aug12. If the contractual due date was Aug5, both amounts stay overdue. The
$9.99 unapplied payment reconciles Aug12 gross aging to the $50 AP control
liability. Backdating the replacement to Aug1 instead intentionally recognizes
both bills before Aug12 ($150 outstanding at Aug11); the SDK does not conceal
that consequence or reinterpret an accepted command on replay.

Executed PostgreSQL tests cover both date modes, historical AP register/aging/GL
agreement, exact retry and changed-due-date idempotency rejection, invalid-date
rollback, and the retained invoice restriction. Migration rollback is not simply
reinstalling the old constraint: existing overdue bills would violate it. Retain
the forward-compatible schema and immutable facts during application rollback;
any eventual downgrade needs an explicit data inventory and recovery plan.
An older SDK can reject an exact overdue-command replay before reaching its
receipt, and older host normalizers may reject the resulting bill on read. A
rollback must retain this compatible correction/read path or suspend those
commands until a compatible application is restored. Do not rewrite due dates
or reverse valid post-cutover facts to make an older binary run. Validate the
constraint scan and lock duration on the representative migration dataset before
production cutover.

## Signed expense lines (0.3.189)

`vendorBills.create` accepts signed expense lines with a strictly positive net
payable. A $100 expense and a -$20 supplier credit remain two commercial lines
and post $100 expense debit, $20 expense credit and $80 AP credit. Negative
lines use positive quantity and negative unit amount; their tax and discount
components must be zero. A negative/zero net bill, inconsistent arithmetic or
an expense using the bill's payable control account fails before writes.

Cash-basis bill-payment applications allocate the remaining signed journal,
including prior reversals, so cent-sized installments cannot over-recognize a
credit. Unapplication reverses the exact original allocation on its effective
date. Immutable source lines, idempotency fingerprints and existing source,
period, account and independent-approval controls remain in force. No schema
migration or consumer postinstall patch is needed.

This does not add negative tax/discount component posting or settlement across
historical and native sources. PostgreSQL integration tests exercise positive
net signed bills, exact installments, replay/conflict, dated reversal, historical
balances and invalid-input rollback. Consumer apps must also permit signed line
storage and maintain their own review and approval workflow.
