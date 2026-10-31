# Reviewed customer settlement across the cutover boundary

Version 0.3.190 adds an opt-in `crossSource` contract to
`commands.paymentApplications.apply` for a native customer receipt applied to an
otherwise unpaid historical QuickBooks invoice. The ordinary same-source command
and checksum remain unchanged.

The caller supplies exact historical/native party IDs, `targetSourceId`, a retained
`reviewRef`, and a complete one-to-one historical-to-native posting account map.
This is settlement authorization, not a name-based party merge. An independent
approver is required even when administrator self-approval is otherwise enabled.
Both sources must belong to the same reporting book in their historical/active
date windows. Original native receipt accounting and the historical invoice's
complete balanced accrual journal are verified inside the transaction.

The application retains both document source coordinates. It updates the two
subledger balances and records a balanced cash-basis allocation in the native
source using mapped accounts. It never rewrites the historical journal, duplicates
the receipt, or posts additional accrual revenue. Installments consume the exact
remaining journal amounts, including cents. Dated customer statements and collection
positions include target-source allocations. A provider replay may preserve the
same original invoice and overlay the retained settlement; changed accounting facts
or provider balances are rejected instead of overwriting settled history.

`paymentApplications.unapply` uses the original journal and posting book to create
an exact dated reversal. It does not consult a newly changed account map. Application
and undo retries retain their original idempotency/version checks. Cash returns
that would release this allocation must first use the independently approved undo
path; generic payment corrections cannot silently release a cross-source target.

Remaining unsupported cases: imported receipt to native invoice; imported credits,
refunds, vendor settlements; invoices with provider settlements, tax/discount or
item/dimension components; and source-aware replacement/correction transactions.
Those require additional explicit provenance and mapping contracts. Provider
cash-flow report normalization is a separate contract and is unchanged.

Schema migration 50 adds nullable target-source coordinates and source-aware
foreign keys, balance triggers and historical fact guards. Null retains legacy
same-source semantics. It does not delete or backfill financial records.
