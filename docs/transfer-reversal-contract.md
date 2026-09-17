# Independently approved native transfer reversal

`financials.transfers.reverse(input)` reverses a settled native document created by
`financials.transfers.record`. The SDK façade exposes
`sdk.commands.transfers.reverse`. Both public entry points export
`ReverseTransferInput`, `ReverseTransferResult`, `TransferReversalApproval`,
`TransferReversalApprovalScope`, and `createTransferReversalApprovalChecksum`.

## Identity and approval

Use `recorded.documentId` as `transferId`. A journal transaction ID, provider ID,
or bank-transfer reference is not a transfer document ID. The SDK resolves the
original accrual transaction and any persisted cash transaction from native
provenance. Use **`result.reversal.transactionId`** as the actual new accrual
reversal transaction ID. `result.cashReversal?.transactionId` is a separate cash
reversal ID. Neither is the original transaction ID or a synthetic response ID.

```ts
import {
  createErpFinancials,
  createTransferReversalApprovalChecksum,
  type ReverseTransferInput
} from "@handrail/erp-financials";

const scope = { tenantId, companyId, sourceId, bookId, currencyCode: "USD" };
const financials = createErpFinancials({ database: postgresPool, ...scope });
const command: Omit<ReverseTransferInput, "approval"> = {
  transferId: recorded.documentId,
  idempotencyKey: "transfer-reversal:request-123",
  date: "2026-09-17",
  memo: "Reverse duplicate transfer",
  operation: {
    actorRef: "user:accountant",
    approverRef: "user:controller",
    requestId: "request:123",
    correlationId: "correlation:123",
    reasonCode: "duplicate_transfer",
    occurredAt: "2026-09-17T12:00:00.000Z"
  }
};
// At approval time, the trusted host authenticates and authorizes the distinct
// approver for this exact command, and durably stores this checksum with its
// approval record. Do not recompute it from execution-time caller input.
const operationChecksum = createTransferReversalApprovalChecksum(scope, command);
// After that host approval succeeds, retain the complete authorized input:
const approvedInput: ReverseTransferInput = {
  ...command,
  approval: { approvalRef: approvedHostRecordId, operationChecksum }
};
const result = await financials.transfers.reverse(approvedInput);
```

The host owns authentication, permissions, approval creation and retrieval. The
SDK is a trusted server library, not an approval authority. A checksum detects
changes to an approved command; it is **not a signature or proof of permission**.
Never accept caller-supplied actor/approver identities, approval records or a
caller-recomputed checksum as authorization. Retrieve the authenticated approval
record from host storage and verify its approver matches `operation.approverRef`.
No live provider or external approval service is called by this command.

The SDK requires complete operation context, a nonempty independent approver
reference (different from the actor), a nonempty `approvalRef`, and the exact
checksum. Its versioned binding includes tenant, company, source, book (including
absence), service currency, transfer document, idempotency key, date, memo and
**every** operation-context field, including approver, timestamp and reason detail.
The caller's default accounting basis and posting-policy setting do not change
which recorded journals must be reversed. Missing/self approval or a tampered
binding fails with `authorization_context_invalid` before financial writes.
Approval reference, checksum, full actor/approver attribution and original-event
provenance are persisted in the canonical `subledger.transfer.reversed` lifecycle
event. The checksum also binds omitted memo versus an explicitly supplied memo.

## Accounting, scope and atomicity

- Original documents, transactions, lines, postings and attribution remain
  unchanged. Original transactions stay `Subledger:transfer`; the original
  document stays settled at its original version. Reversal state lives in
  canonical links and lifecycle evidence.
- New adjustment journals use the original posted accounts, amounts, currency,
  parties, items and dimensions, swapping debit and credit. Both recorded bases
  receive balanced opposite postings. A historical native transfer with only an
  accrual journal receives only that reversal; no cash history is invented.
- Tenant/company/source ownership and original `ledger.posted` book provenance
  must match. Missing provenance fails closed. Imported provider transfers and
  unrelated document types are unsupported. Service single-currency and canonical
  account eligibility checks still apply.
- New reversals enforce fiscal periods even for `legacy_unrestricted` callers:
  missing or closed periods and posting lock dates reject new facts. The existing
  adjustment policy permits closing periods. The fiscal advisory lock is held to
  commit, serializing SDK close/reopen/lock-date changes.
- One database transaction includes both journals, links, lifecycle events,
  report snapshot invalidation and outbox events. Any failure rolls all of it back.
  Generic journal lifecycle source restrictions remain unchanged.

The result has `status: "reversed" | "already_reversed"`, `originalTransferId`,
`originalTransactionId`, `reversal`, optional `cashReversal`,
`journalEntryLinkIds` and `lifecycleEventIds`. Each journal result includes its
actual transaction/line/posting IDs, lifecycle event and write counts. There is
one canonical `reversal` link per original persisted basis, referencing the
original document posting event. The final document event references the same
provenance and lists the reversal transaction IDs.

## Replay and concurrency

Persist the complete approved command and replay it unchanged, including its
approval reference and original operation timestamp. Every retry still needs
valid independent approval and correct scope. Exact replay after service/pool
recreation returns the same durable IDs, `already_reversed` / `already_posted`,
and zero financial write counts. Exact replay remains valid after period closure
because it creates no financial facts.

Changed command content with the old checksum is an authorization error. A
changed, newly approved command reusing a committed idempotency key fails with
`idempotency_conflict`, including a changed transfer or approval reference. A
new key competing for an already reversed original fails with `invalid_input`
(the canonical terminal-reversal conflict). Rollback leaves the key available
for retry. Use a fresh key only for a genuinely different authorized operation.

Transaction advisory locks and existing canonical unique constraints arbitrate
concurrent calls across independent PostgreSQL connections. Identical concurrent
requests yield one reversal and one replay; conflicting same-key commands,
different transfers sharing a key, and different keys for the same original
cannot commit duplicate reversals. Hosts supplying a custom transaction runner
must provide a real atomic PostgreSQL transaction on one connection per callback,
using READ COMMITTED (as the SDK pool wrapper does). Hosts choosing stronger
isolation must retry whole transactions on serialization/deadlock errors using
the unchanged approved input.

No migration, schema checksum, dependency or version change is needed. Deposit
reversal from `24a6bb6edffcd2e0f677a22a7f1e241a59cde3a4` retains its existing
public input, replay keys and persisted payload contract.

## Consumer handoff

This SDK prerequisite belongs to checklist item
`f88a8739-b924-4e6b-9302-a6b37cf1592c`; it does **not** complete that item. Native
finalization must supply the published **full commit SHA** before adoption.
The base `24a6bb6edffcd2e0f677a22a7f1e241a59cde3a4` is deposit-only and is not a
published transfer candidate. No candidate publication is asserted here.

After the SDK request settles, the same checklist item must inspect the published
candidate, integrate its authorized public HTTPS Git full-commit pin and matching
ERP lockfile through the normal install/build pipeline, preserve existing deposit
adoption and sibling changes, and add real installed-SDK transfer consumer tests.
Do not use file/workspace/registry/tarball/branch/tag dependencies or patch installed
SDK files. FinanceService integration remains assigned to dependent item
`d3d9c08f-7649-4d4b-96fa-cffda89c40b6`. This does not replace deposit prerequisite
`a94f1f9b-1e99-46b7-820b-c3eb3adfadf7` and contains no ERP, UI or mobile work.

See [verification evidence](transfer-reversal-verification.md) for exact checks
and changed-file attribution.
