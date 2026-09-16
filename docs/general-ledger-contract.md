# General ledger and reporting-book account contract

The package owns the General ledger list, matching summary, provenance, and
chart-account mutation rules. Host routes must pass the same
`GeneralLedgerFilters` object to `listGeneralLedger` and
`getGeneralLedgerSummary`; they must not calculate cards from a page of rows.

```ts
const filters = {
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  accountKey: "service_revenue",
  sourceId: "native_erp",
  transactionType: "Subledger:invoice",
  classId: "managed_services",
  dimensionKind: "department",
  dimensionId: "security_operations",
  polarity: "credit",
  search: "INV-1001"
} as const;

const [page, summary] = await Promise.all([
  sdk.queries.listGeneralLedger({ ...filters, limit: 50 }),
  sdk.queries.getGeneralLedgerSummary(filters)
]);
```

Dates are strict ISO calendar dates. Limits are integers from 1 through 200.
Search is literal, case-insensitive, and limited to 100 characters. Other
filter values are limited to 200 characters. Generic dimension kind and id
must be supplied together. Class matching accepts either the canonical
`dimensionId` or provider `sourceDimensionId`. A page cursor is scoped to the
book and the normalized filter set, so changing any filter invalidates it.

Each row reports both transaction and posting dates, transaction type, at most
20 canonical dimension references with an omitted count, and bounded source
provenance (source role/system/environment, source transaction/posting ids,
and compact source-object identity when present). Provider payload previews,
storage references, credentials, and raw provider data are never returned.

## Reporting-book account mutations

Every account explicitly declares `accountRole: "header" | "posting"` and
uses optimistic concurrency. Create with `expectedVersion: 0`; use the returned
positive `version` for updates. Retrying the identical operation request and
payload returns the existing version. Reusing that request id with different
input is an idempotency conflict, while a stale version is an
`optimistic_concurrency_conflict`.

```ts
const created = await sdk.books.defineAccount({
  operation,
  bookId: "primary",
  bookAccountKey: "service_revenue",
  accountNumber: "4010",
  name: "Service revenue",
  classification: "income",
  accountRole: "posting",
  parentBookAccountKey: "income",
  expectedVersion: 0
});

await sdk.books.defineAccount({
  ...sameFields,
  operation: nextOperation,
  name: "Consulting revenue",
  expectedVersion: created.version
});
```

Schema version 16 introduced unique non-null account numbers per
tenant/company/book. Parents must remain active headers, accounts with children
cannot become posting or inactive, mapped accounts cannot become headers, and
`accountType` cannot change while children or mappings depend on it. Classification,
currency, hierarchy, and identity rules are unchanged.

## Inactive mapped accounts (schema version 25)

`books.defineAccount` is the public lifecycle operation: create with
`active: false, expectedVersion: 0`, deactivate with `active: false` and the
current version, and reactivate with `active: true` and the current version.
Send the complete account definition on each call (including parent, number,
type, subtype, and currency when present); this is a definition, not a partial
patch. Omitting `active` defaults to `true`. Use a new operation request id for
each transition. An identical retry of the latest operation returns its original
version; different input under that request id conflicts. An older retry after
another transition is rejected by its stale version and cannot undo that transition.

`books.mapAccount` accepts active **or inactive posting accounts** with the same
classification as the source account. A mapping records reporting identity; it
does not grant permission to post. Deactivation/reactivation preserves canonical
source-account identity, book-account identity, mapping identity, and all posted
facts. No mapping deletion, remapping, or artificial activation is needed.

For a mirrored source account, use `commands.accounts.upsertTree` with the same
canonical `accountId` (or original `accountKey`) and `sourceAccountId`, and its
actual active state. Then call `books.defineAccount` with that state and
`books.mapAccount` with the existing target key. Source and book active flags are
independent; both must permit a new native posting. To make all three operations
atomic, bind the SDK to the client of a host-owned transaction:

```ts
await database.transaction(async client => {
  const txSdk = createErpFinancialsSdk({
    ...sdkScope,
    database: { transaction: work => work(client) }
  });
  await txSdk.commands.accounts.upsertTree({
    operation: sourceOperation,
    parent: { ...sourceDefinition, active: false }
  });
  const account = await txSdk.books.defineAccount({
    ...bookAccountDefinition,
    operation: bookOperation,
    active: false,
    expectedVersion: currentVersion // 0 for creation
  });
  await txSdk.books.mapAccount({
    operation: mappingOperation,
    bookId: sdkScope.bookId,
    sourceId: sdkScope.writeSourceId,
    accountId: canonicalAccountId,
    bookAccountKey: account.bookAccountKey
  });
});
```

New native journal/subledger posting through a book-scoped SDK rejects either an
inactive source account or an inactive mapped book account with `invalid_input`.
The posting transaction holds the source hierarchy and book-account lifecycle
locks through commit, serializing with public account transitions. An identical
replay of an already posted operation remains valid while inactive and adds no
postings. The lower-level service without `bookId` enforces source-account state;
pass `bookId` (as `createErpFinancialsSdk` does) to enforce that book's mappings.
Provider historical fact import remains separate from native posting eligibility.

Financial statements, retained earnings, general-ledger reads, and posted entries
retain inactive-account history. The chart includes inactive accounts carrying
balances (and required ancestors); `includeInactive: true` also includes empty
inactive accounts. A header with children must still remain active.

### Migration and consumer adoption

Run the exported `migratePostgresSchema(database, { appliedByRef })` before using
the lifecycle. Fresh installations follow the ordered registry through v25.
Existing versioned databases follow their pending path through v24 and then
`20260915010000_allow_inactive_mapped_accounts.sql` (v24 → v25). This migration
replaces the hierarchy/mapping trigger functions without rewriting old migration
checksums, accounts, mappings, or posted facts. Migration execution and its ledger
entry are transactional, and a repeat run is a no-op. Earlier migrations retain
their existing preconditions.

This SDK change is intermediate evidence for Hitcents Owner Task
`5c292ee2-4160-40be-8e05-476a5c66cfd9`. Handrail finalization owns the version bump,
commit, and push. The working patch has no consumable resulting revision until
that process completes. After the existing task independently inspects this
result and obtains scoped authorization for the exact Hitcents dependency update,
pin both dependency files to the resulting **full commit SHA** using public HTTPS:

```sh
npm install --save 'git+https://github.com/c0x65o/handrail-sdk-erp-financials-js.git#<full-approved-commit-sha>'
```

The normal install `prepare` builds the SDK. Apply the SDK migrations, integrate
the mirror lifecycle, then resume item `7e4922fd-8494-4c6a-94a4-4af502aa6887` for
direct/Cents/HTTP acceptance. The existing dependency-update restriction remains
in force; this SDK work does not authorize or perform the Hitcents pin update.

## Release and Spartan recheck

The queued Handrail worker leaves versioning, commit, tag, and publication to
the post-agent release flow. Once that flow makes the approved commit available, update Spartan Cyber ERP v2
from its repository under its own authorization:

```sh
npm install --save 'git+https://github.com/c0x65o/handrail-sdk-erp-financials-js.git#<full-approved-commit-sha>'
npm ls @handrail/erp-financials
```

Confirm both `package.json` and `package-lock.json` resolve the new release
commit rather than `b8546a28c2f22be8ae84c6fb10607134b7213528`. Then run the
Spartan focused financial contract/type checks and retry the General ledger
source node. The unblock proof is: schema version 16 is migrated, the public
`GeneralLedgerFilters`/provenance types import successfully, filtered list and
summary totals match, and reporting-book account create/update calls supply
`accountRole` plus `expectedVersion`.
