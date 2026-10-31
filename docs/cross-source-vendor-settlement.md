# Reviewed cross-source vendor settlement

Version 0.3.194 / schema 52 extends `paymentApplications.apply` to a native
`bill_payment_to_bill` application against an otherwise unpaid historical
QuickBooks vendor bill. It uses the existing `crossSource` review contract:
`targetSourceId`, `nativePartyId`, `historicalPartyId`, immutable `reviewRef`,
and complete `historicalAccountId` → `nativeAccountId` mappings.
`CrossSourceSettlement` is the shared type; the previous
`CrossSourceCustomerSettlement` export remains a compatible alias.

The host must resolve an explicitly reviewed identity association and current
account mapping decisions, freeze the source/target versions and approval
fingerprint, and require a different active approver. The SDK checks the exact
book, source windows, currency, parties, original native payment provenance,
historical journal provenance, balances, periods, versions and account classes.
An identity association alone never authorizes posting.

The imported bill and its accrual journal remain unchanged. Applying a native
payment recognizes the exact expense portion in the active source's cash basis
on the application date and clears the mapped payable control. Installments
consume remaining journal cents; the final installment exhausts the exact
remaining amount. Dated unapplication reverses those retained cash postings and
restores both open balances. Commands and reversals retain their normal
idempotency and independent approval contracts. Provider refresh cannot rewrite
settled accounting facts.

Schema 52 only replaces the application validation function to admit the new
reviewed application type. Existing migration files and financial facts are
unchanged; the schema-51 provider refresh balance repair remains in force.

## Signed expense offsets

Version 0.3.194 also accepts a positive net payable with negative expense lines.
The retained provider journal must balance, and its single AccountsPayable credit
must equal the original bill amount. Every other account must have an explicitly
reviewed expense/COGS/other-expense mapping. The cash allocator uses that payable
control, not gross journal debits, to allocate signed offsets. It subtracts exact
prior recognition and reversal postings so the final installment consumes every
remaining cent. Tax liabilities, inventory and dimensional journals are rejected.
No migration, historical fact rewrite, source-window extension or API change is
required. Same-source imported allocation retains its earlier contract.

## Explicit limits

This supports native payments against unpaid historical bills with one payable
control and unambiguous expense/COGS/other-expense offsets. Historical payments,
provider-settled bills, credit/refund settlement, tax component journals,
inventory/item or dimension mappings remain unsupported. No historical
source window is widened. No credentials, provider writes, or external payment
instructions are involved. Provider-owned bill holds still require provider
payment controls; native hold mutation cannot be used to rewrite imported bills.

## Validation

Focused PostgreSQL tests exercise fresh install and populated schema-51 upgrade,
exact installments, dated summary/register reads, cash-only recognition, replay,
dated undo, scope/version/mapping rejection, and immutable provider facts.
Existing cross-source customer tests and migration/manifest tests remain passing.
Full-suite and host adoption evidence are required before production adoption.
