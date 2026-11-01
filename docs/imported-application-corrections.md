# Original imported application corrections

`commands.paymentApplications.unapply` accepts optional `importedCorrection`:
`applicationSourceId`, `historicalPartyId`, `nativePartyId`, `reviewRef`, and exact `accountMappings`.
The host binds these fields, the application version, effective date, and retained journal to an immutable request approved by a different finance manager.

The application, applied event, dates, amounts, and original provider ledger remain in their historical source. Its terminal event is recorded at those same coordinates so existing dated balance queries keep the original settlement until the correction date. Only the compensating cash journal and outbox are written using the active service source. The service never rebinds its writer or extends a historical source window. No bank cash or accrual posting is reversed by unapplying an allocation.

This initial contract accepts one complete original QuickBooks BillPayment-to-Bill application, with matching vendor/currency, a fully paid bill/payment, and exact plain bill accrual plus payment cash recognition evidence. Mapping must preserve expense/payable classifications. Missing, partial, split, dimensional, signed/component, or ambiguous provider allocations fail closed. They require additional explicit accounting contracts, not guessed proportional journals.

Retry compares the original application version, date, accounting source/book, reviewed identities and sorted account mappings. A changed request fails rather than producing another compensation.

Canonical imports, operational document replay and dual-basis replacement share the correction source lock. Corrected bill/payment identities and their basis journals are preserved. Replay returns `imported_application_correction_requires_provider_reconciliation` dependencies, including changed or deleted provider snapshots. New provider applications touching the corrected bill require explicit reconciliation. This is preservation, not provider deletion evidence or a provider sync command.

No schema rewrite or historical writer change is required. Existing callers without `importedCorrection` retain their original behavior.
