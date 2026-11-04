# Vendor funding read contract

Shared SDK fix - Spartan should pick it up.

`queries.getVendorFundingDocuments({ vendorId, asOfDate, limit, cursor })` returns source-qualified bill-payment and vendor-credit balances. Dated application and reversal evidence determines the available amount; historical source coordinates remain intact. Terminal transactions have zero available balance. Provider-owned current snapshots retain the same fallback as existing aging reads.

Pages share a complete-selection revision, with a 10,000-document scan bound. Changed accounting, party, book or date invalidates a continuation. This is a read contract, not approval to settle funds or a complete vendor liability statement. Vendor refunds need a separate document/application contract before gap 25 can close.

Validation: lint, typecheck, build and seven read-model tests passed in native action 184217cb-7261-49cc-ba7c-2f0dc8c954c3. Disposable Unix-socket PostgreSQL application/reversal proof passed in c7c034d4-29f5-4925-8896-ac52de5ebaed; fixture teardown confirmed. The subsequent version-only change is 0.3.206.
