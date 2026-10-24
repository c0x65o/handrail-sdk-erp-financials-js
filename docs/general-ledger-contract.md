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

## Account register with exact running balances

Use `queries.getAccountRegister` for a chronological account register rather
than rebuilding a register from every journal. It returns opening/period/closing
controls and bounded lines in one financial statement snapshot. The full
contract, cursor invalidation rules and direct-versus-descendant semantics are
in [SDK v1 contract](sdk-v1-contract.md#exact-paginated-account-register-0394--schema37).

```ts
const register = await sdk.queries.getAccountRegister({
  accountKey: "cash",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  limit: 50
});
// Render register.openingNet and each item's runningNet as exact decimal strings.
// Fetch register.nextCursor on demand; restart after optimistic_concurrency_conflict.
```

For a paginated chart use `queries.getAccountChart({ periodStart, periodEnd,
limit: 50 })`. Render its whole-book `summary` for control totals and each row's
`direct` amounts for additive account reporting. `inclusive` amounts are explicit
hierarchy subtotals. Search/classification filters select rows while the controls
remain whole-book; label that scope in the host UI. See the SDK contract for
inactive-account, cursor and validation semantics.

## Complete posted journal register (0.3.96 / schema38)

Use `queries.getJournalRegister({ periodStart, periodEnd, limit: 50 })` for the
posted journal workspace. It includes imported canonical facts and native
subledger postings even when they have no `journal_entry.posted` event. The older
`listJournalEntries` and `getJournalEntry` retain their native manual-journal
contracts for compatibility; they are not complete GL journal reporting APIs.

The register selects ledger facts by **posting date**, basis, book currency and
per-posting source effective windows. Document date/status are separate evidence:
a void/deleted source document does not silently remove facts already in the
ledger. `firstPostingDate`, `lastPostingDate` and amounts describe only the
requested posting window. A window can contain only one side of a journal across
dates; the API exposes that difference rather than silently balancing it.
`summary` covers the whole book/window; `matched` applies optional exact source,
transaction type and native origin-module filters plus literal text search.
Counts and money remain exact strings. No row-count ceiling truncates controls.

Use `queries.getJournalPostingPage({ sourceId, transactionId, periodStart,
periodEnd, limit: 50 })` for bounded detail. It returns the journal header and
posting page in the same SQL snapshot; postings without optional transaction
line records remain visible. Cursor paging is descending posting date and stable
identity. Scope/filter mismatches fail `invalid_input`; accounting or book
configuration changes fail `optimistic_concurrency_conflict`, requiring a fresh
first page. Cursors are continuation positions, not trusted balances or access
grants. Each read rechecks book membership. The conservative dated revision is
source-wide, so unrelated in-window posting can also invalidate a cursor.

As of 0.3.98, source, canonical transaction and continuation posting identities
support up to 500 characters consistently in request filters and cursors. Earlier
journal cursors incorrectly rejected source IDs over 200 or canonical IDs over 300
that the first page could return. Longer stored continuation identities fail
explicitly before an unusable next cursor is issued. The cursor itself remains
bounded to 8192 characters; no schema migration or accounting facts change.
Provider provenance fields keep their existing independent bounds (for example,
`sourcePostingId` and `sourceTransactionId` are at most 300 characters); these are
not the canonical posting/transaction identities used for pagination.

A native manual-journal preparation event is optional provenance, not a fabricated
actor for imports or native subledger commands. Native reversal/correction links
are reported separately from the source document status. This API does not
replace document-specific audit histories or expose an unbounded lifecycle array.
Hosts must label absent journal preparer evidence accurately and link to the
appropriate operational document/audit surface using stable identities.

The database aggregates controls and selects bounded pages; only the chosen
journal rows receive lifecycle enrichment. Schema38 adds a transaction-leading
posting index for detail. Existing migrations/checksums remain immutable. The
normal transactional index build can block writes while building; production
cutover must schedule it under the applicable database approval and recovery
procedure. No accounting facts are rewritten by this migration.

These reads reject stored nonzero sub-cent postings rather than silently
rounding them, including sub-cent rows outside the displayed page whose sum is
an exact cent. Existing broader report precision support is unchanged.

## Reporting-account deep links (0.3.99 / schema38)

`queries.resolveReportingAccount({ referenceType, reference, asOfDate })` resolves
one metadata definition. `referenceType` is explicitly `book_key` or
`account_number`; the SDK never guesses an identity type from a prefix. The
returned `bookAccountKey` is suitable for `getAccountRegister`, not source-account
posting commands. References are nonempty and bounded to 512 characters.

The query uses the same definition space as the chart: configured book accounts
and unmapped source accounts whose binding has begun by `asOfDate`. Inactive
accounts and ended source bindings remain visible for historical navigation.
Current account definitions are returned; the date does not reconstruct past
names or mappings. Missing/archived books fail `missing_book`; unmatched
references fail `missing_account`; duplicate account numbers or key collisions
fail `invalid_input`. A host must ask for an unambiguous reporting key rather than
choosing the first match or guessing a source prefix.

One SQL metadata snapshot checks book scope and selects at most two matches to
detect ambiguity. It reads no financial facts, computes no balances, and does
not grant command eligibility. Hosts should preserve explicit identity kinds in
links and use the register's own scoped controls and revision-bound pagination.
No migration is required.

## Bounded journal origin groups and exact references (0.3.100 / schema38)

Journal register requests can supply `originGroups`, an ordered array of up to 20
rules `{ id, originModules, transactionTypeContains }`, and optionally select
one `originGroupId`. IDs are unique and bounded to 80 characters; `unclassified`
is reserved. Each term list contains at most 20 nonempty strings, each at most 100
characters. A rule needs at least one term. The SDK captures and validates the
configuration before awaiting database work. Hosts should own this configuration
on the server, not accept arbitrary classification rules from a browser.

A recorded origin module matches `originModules` exactly and takes precedence
over transaction type. Only records without an origin use case-insensitive,
literal transaction-type substring rules. First matching rule wins; unmatched
records use `unclassified`. SQL wildcards have no special meaning. This is
display classification, not new financial provenance or posting policy. In
particular, an unknown origin must not be invented as a manual preparation event.

Each row receives its optional `originGroupId`. Optional page `originGroups`
contains exact journal/posting counts and debit/credit controls for every
configured group, including zero groups and `unclassified`. These counts apply
ordinary filters before the selected origin-group filter. Whole-book `summary`
remains independent of filters; `matched` includes the group selection. All
controls, groups and selected rows use the same SQL statement snapshot. Group
configuration/order and selection are bound into continuation cursors.

`reference` optionally matches a canonical transaction ID, transaction number,
or source transaction ID **exactly**, bounded to 512 characters. It is not a
substring search. References may be ambiguous across sources or number schemes:
hosts must inspect `matched.journalCount`, reject ambiguity and retain the
returned `sourceId` plus `transactionId` for detail. Never pick the first match
as an identity resolution rule. Scope and posting-window restrictions still
apply. This report lookup includes whole-book controls and therefore has report
cost, not constant-time metadata-lookup cost.

Groups and references are additive: existing requests without them retain their
response shape. No new schema migration or accounting write is introduced.

## Journal query work reuse (0.3.101 / schema38)

Unfiltered matched controls reuse the whole-window summary. With origin groups,
matched controls sum the disjoint group controls, including the selected group
when supplied. The selected page reads the same matching set without an extra
materialized copy; metadata filters remain materialized to avoid repeated
transaction lookups. Scope, date windows, exact arithmetic, and the single SQL
snapshot contract are unchanged. No schema change or persisted balance is added.

The synthetic one-million-journal/two-million-posting PostgreSQL 15 benchmark
measured unfiltered first pages at 4.62–4.96 seconds versus 5.08–5.93 seconds
in the preceding run on the same shared host. Grouped first pages remained
8.04–8.75 seconds; four concurrent grouped requests took 10.91 seconds. These
are measurements, not a latency guarantee or scale acceptance. Whole-window
aggregation and origin classification still dominate. The benchmark also
records a separate post-ANALYZE diagnostic; it does not change database
configuration or execute maintenance as part of a runtime report.

## Journal P&L effects (0.3.102 / schema38)

Pass `includeIncomeEffect: true` to `getJournalRegister` or
`getJournalPostingPage` for SDK-owned P&L trace values. Register controls,
matching controls, origin groups and each journal gain `netIncomeEffect`, an
exact signed decimal. Detail postings also gain `accountClassification` and
`netIncomeEffect`. Omitting the option retains the existing response shape and
does not add classification joins to the default report. The option is captured
before awaiting I/O and binds continuation cursors.

The effective classification is the mapped reporting-book account's class, or
the source account's class when unmapped, matching `getFinancialStatement` for
`profit_and_loss`. Income, other income, COGS, expense and other expense contribute
credit minus debit; asset, liability and equity contribute zero. Classification
labels or descriptions are never inferred from journal memo text. Only postings
in the requested book, source windows, basis, currency and posting-date range
contribute. A journal spanning dates can therefore have different effects in
different windows. Reversals remain separate posted facts; lifecycle status
does not remove either original or reversal effects.

The register's unfiltered `summary.netIncomeEffect` reconciles to the statement's
`totals.netIncome` for the same scope/window/basis at the same database state.
Separate calls may observe different committed states. Within each journal call,
controls, classification, rows and revision share one SQL statement snapshot.
Detail `journal.netIncomeEffect` covers the whole scoped journal, not only the
returned posting page. Hosts must display these values rather than sum downloaded
pages or substitute another calculation when the field is unavailable.

This is an additive read option with no schema migration, financial write or
new accounting authority. Its extra classification work was measured separately on the shared PostgreSQL 15
fixture: one million journals over five years, two dated sources, 200 accounts,
and 16,957 journals in the selected month. With origin groups also enabled,
monthly first pages took 0.81–0.89 seconds and next pages 0.88–0.90 seconds.
The whole-history read took 11.24 seconds. Four readers alongside four writers
completed 400 native journal posts at 99.17 posts/second over 4.03 seconds;
concurrent report p95 was 0.99 seconds. Exact effects reconciled to the independent
fixture controls and SDK statement. This short synthetic workload is not a
sustained soak, production proof or full-history latency acceptance.

## Bounded income attribution (0.3.104 / schema38)

`queries.getIncomeAttribution({ periodStart, periodEnd, dimensionKind,
accountingMethod?, sourceId?, limit?, cursor? })` returns a page of source-qualified
profit-and-loss groups, a revision, exact whole-request controls, and assigned,
unassigned and ambiguous coverage controls. The SDK owns all classification,
signed arithmetic, grouping and pagination. Hosts must not download journal or
invoice collections to reconstruct this report.

Each visible P&L posting belongs to exactly one group. A single structurally valid
reference of the requested kind is assigned. Repeated identical identity pairs
count once, ignoring display names. Multiple distinct pairs or malformed
references are ambiguous; absent references are unassigned. Identity is the
exact `(sourceId, dimensionId, sourceDimensionId)` tuple. Equal IDs in different
sources never merge. A canonical ID plus a source ID is distinct from a
source-only reference; the reader does not invent alias equivalence. Invalid
top-level dimension JSON and references without a string kind remain ambiguous.

Assigned describes explicit posting provenance, not proof that an external order
exists. BLU commands must validate operational relationships before attaching
`blu_order` references, and report enrichment must detect missing operational
identities. Names are display metadata and are not attribution keys. Historical
unattributed costs must remain visible until an approved, evidenced migration
provides their ownership; no text matching or proportional allocation is implied.

Money and counts are strings. Income includes `income` and `other_income`; costs
use `cost_of_goods_sold`; expenses include `expense` and `other_expense`, matching
SDK P&L statement totals. Income is credit minus debit; costs and expenses are
debit minus credit. Gross profit and net income are computed by the SDK. These
are posted net accounting amounts, not gross sale prices, discounts, or a claim
that all COGS is garment cost. The report does not manufacture those distinctions.

Rows, summary, coverage, classifications and revision use one PostgreSQL
statement snapshot. Source effective dates, book mappings, basis, currency and
an optional source filter apply to all controls. Unassigned and ambiguous rows
are included in the page population and controls. There is no total-ledger item
cap, no per-document fetch loop, and no application-memory aggregation of history.
The normal page bound still applies. Summaries scan the requested period in the
database; a long period is not constant-time. Individual sub-cent facts or missing
account classification fail closed, even when their sums could round to cents.

Continuation uses the group's opaque key and the current accounting revision.
Changes to postings, mapping or book metadata invalidate an old cursor with
`optimistic_concurrency_conflict`; restart from page one. A cursor is scoped to
request filters and tenant/company/book. Its page size may change. Caller inputs
are captured before asynchronous work. A reporting-book change between metadata
lookup and the report snapshot also fails closed.

Use `test/income-attribution-scale.postgres.test.ts` through the disposable
PostgreSQL harness with `ERP_FINANCIALS_RUN_SCALE_TESTS=1`. The default fixture has
one million two-line journals over five years, mixed revenue/COGS, two dated
sources and explicit missing/conflicting attribution. `ERP_FINANCIALS_SCALE_JOURNALS`
allows smaller harness rehearsals; those are not million-entry evidence. This is
a synthetic benchmark with four writers and four readers, not production or a
sustained-load acceptance threshold. Report measurements with dataset, settings,
hardware, and memory limitations rather than claiming scale from the API shape.

Since 0.3.106, `getIncomeAttribution` accepts an optional `attributionStatus`
(`assigned`, `unassigned`, `ambiguous`), an exact `reference` (`kind: dimension`
or `source_dimension`, plus `id`), and `sort` (`identity`, `cost_desc`,
`income_desc`). Reference matching is case-sensitive and literal, not wildcard
or label search. Source-qualified identities remain distinct; a source reference
can match both a source-only group and a canonical/source pair. Use `sourceId`
when a specific accounting source is intended. Operational display numbers must
be resolved by the host; the SDK never guesses them from memo or description.

`summary`, `coverage`, and `groupCount` retain the whole requested date/source
scope. `matched` contains exact totals and `groupCount` after the status/reference
filters, independent of page size. `selection` echoes the applied filters and
effective sort. Both are optional in the TypeScript result for compatibility
with older stored fixtures; this SDK always returns them. Consumers offering
filter controls must verify their presence rather than assume an older SDK
applied unknown request fields.

Monetary sorts use exact PostgreSQL numerics, descending, with the opaque group
identity as the stable ascending tie-breaker. The cursor carries the exact
amount boundary, supports negative net amounts, and is bound to all selection
filters and sort. A changed filter/sort requires a new first page. No filters
are implemented by collecting or sorting pages in the host. Default identity
requests retain the prior cursor fingerprint and ordering.
