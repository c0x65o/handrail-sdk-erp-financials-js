# Canonical deposit reversal

[PostgreSQL verification and candidate evidence](deposit-reversal-verification.md).

`financials.deposits.reverse(input)` reverses a native deposit created with
`financials.deposits.record`. The SDK façade exposes the same command as
`sdk.commands.deposits.reverse`. `ReverseDepositInput` and `ReverseDepositResult`
are exported from both `@handrail/erp-financials` and `@handrail/erp-financials/sdk`.

```ts
import { createErpFinancials, type ReverseDepositInput } from "@handrail/erp-financials";

const financials = createErpFinancials({
  database: postgresPool,
  tenantId,
  companyId,
  sourceId,
  // Include bookId exactly when it was supplied when recording the deposit.
  bookId,
  currencyCode: "USD"
});

const command: ReverseDepositInput = {
  depositId: recordedDeposit.documentId,
  idempotencyKey: "deposit-reversal:approval-123",
  date: "2026-09-17",
  memo: "Reverse duplicate bank deposit",
  operation: {
    actorRef: "user:accountant",
    approverRef: "user:controller",
    requestId: "request:deposit-reversal-123",
    correlationId: "approval:123",
    reasonCode: "duplicate_deposit",
    occurredAt: "2026-09-17T12:00:00.000Z"
  }
};
const reversal = await financials.deposits.reverse(command);
```

The host authenticates the actor and approver and authorizes their actions. The
SDK requires complete operation context and a nonempty approver reference distinct
from the actor reference on every call, including retries. Persist the authorized
command and retry it unchanged: approval, request, correlation, reason, timestamp,
date, memo, deposit and idempotency key are part of the durable replay contract.
Use the returned **document ID** as `depositId`, not the journal transaction ID.

## Results and persisted behavior

- `status` is `reversed` or `already_reversed`.
- `originalDepositId` and `originalTransactionId` identify the unchanged document
  and its primary accrual transaction.
- `reversal` is the accrual `PostJournalEntryResult`; `cashReversal` is present
  when the original has its separate persisted cash journal. Each exposes its
  own transaction, lines, postings, lifecycle event, write counts and status.
- `journalEntryLinkIds` identifies the canonical `reversal` links for each
  original transaction. `lifecycleEventIds` includes the journal posting/link
  events and the document's `subledger.deposit.reversed` event. The document
  event and journal links reference the original document posting event.

Original transactions remain `Subledger:deposit`, with their original source IDs,
dates, numbers, memo, currency, accounting basis, payload references and operation
attribution. The original subledger document remains settled with its original
identity, amounts, metadata and version. Reversal state is represented by canonical
links and the new lifecycle event, not by rewriting that document. Adjustment
journals contain balanced opposite postings in each original persisted basis,
preserving account, currency, party, item and dimension references. The caller's
default accounting basis does not change the recorded bases.

Tenant, company and source must own the original document. Book scope must match
the original immutable `ledger.posted` outbox evidence, including the distinction
between no book and a named book. Missing book evidence fails closed. Currency
must match the service's single-currency policy. Existing account eligibility
checks apply to new reversal postings.

New reversals always enforce fiscal periods, even if the caller configured
`legacy_unrestricted`: missing/closed periods and posting lock dates reject the
command. Closing periods permit adjustments under the existing journal policy.
The command holds the fiscal scope advisory lock until commit to serialize with
SDK close/reopen and posting-lock changes. Exact replay remains valid after
period closure because it writes no new financial facts.

One database transaction covers both bases, journal links, lifecycle events,
report snapshot invalidation and outbox events. Transaction advisory locks,
existing idempotency constraints and the terminal reversal unique index prevent
duplicate or competing reversals. Identical retries after process/pool recreation
return the same persistent IDs, `already_reversed` / `already_posted` statuses,
and zero write counts. Changed content under the same key raises
`idempotency_conflict`; another key for an already reversed deposit raises the
existing terminal lifecycle validation error (`invalid_input`). Failures roll
back the entire operation.

## Compatibility and scope

No migration or schema-manifest change is required. This command uses the
existing v25 schema, immutable lifecycle/outbox records and journal-link
constraints. Existing migration SQL and checksums are unchanged. Existing
deposits recorded by v0.3.53 are supported without relabeling or backfill.

The command only accepts settled native deposit documents with `Subledger:deposit`
transactions and original posting provenance. Imported provider deposits or old
records without that evidence fail closed. A historical deposit with no persisted
cash journal receives only its accrual reversal; the command does not invent
historical cash postings. Generic journal reversal remains restricted to journal
sources. Transfer reversal is separate scope.

## ERP adoption handoff

This is the SDK prerequisite for ERP Owner Task
`a94f1f9b-1e99-46b7-820b-c3eb3adfadf7`, goal
`7eb96203-af6a-4618-bf0b-0bdd5e643a1e`. The worker leaves changes uncommitted.
Native finalization owns any permitted version bump, commit and push. The base
checkout is `23095ee7d8e225c5336996ca62378c8a3977c0a3` (v0.3.53); it is **not** a
revision containing this new API. No approved published candidate SHA is asserted.

After finalization, verify the approved full SDK Git SHA and queue ERP-scoped
adoption through normal installation, updating `package.json`, `package-lock.json`,
expected version metadata, `allowScripts` and applicable packaging assertions.
Retain public HTTPS Git dependencies pinned to a full SHA; do not substitute
file/workspace/tarball dependencies or patch `node_modules`. ERP item
`865b56bf-181a-4635-a1fd-ce15d29ad0a3` and adapter item
`4442b665-3900-4dae-bda1-e0d674254438` resume after this prerequisite. No ERP or
adapter implementation is included here.
