# handrail-sdk-erp-financials-js

Provider-neutral TypeScript foundation for reusable ERP accounting and financial reporting.
This package is intended to give host ERP apps a shared kernel for canonical
accounting facts, schema and migration manifests, deterministic
fixture/reference report formulas, rollups, snapshots, freshness tracking,
fixtures, validation utilities, fiscal controls, immutable journal lifecycles,
and atomic receivable/payable/cash subledgers.

The package boundary follows the repository docs:

```text
source adapters -> canonical accounting facts -> rollup/snapshot engine -> report APIs -> app UI and AI tools
```

QuickBooks is the first adapter target, but it is not a package dependency or a
credential owner. Host apps should use the Handrail QuickBooks SDK/runtime
contract for provider access and pass safe source references plus normalized
accounting facts into this package. This repository must not store Intuit tokens
or define new QuickBooks credential environment variables.

## Journal lifecycle read compatibility

Version 0.3.186 fixes `queries.getJournalEntry` for journals with reversal, void,
correction or replacement links. The read now includes the joined lifecycle
identity required for each link's provenance. Schema 49 and public API shapes
are unchanged; this fix performs no accounting mutation or historical repair.
Real PostgreSQL tests cover both original and related journal reads for all
four transitions. Existing ledger facts are preserved.

## Install

```sh
npm install
```

The preferred new-host entry point is `@handrail/erp-financials/sdk`. The root
`@handrail/erp-financials` entry point remains the compatibility and advanced
kernel surface. Local builds emit ESM JavaScript and TypeScript declarations to
`dist/`. Undeclared subpaths, direct `src/`/`dist/` imports, copied package shims,
and host-local financial reimplementations are not supported surfaces.

```ts
import { createErpFinancialsSdk } from "@handrail/erp-financials/sdk";

const sdk = createErpFinancialsSdk({
  database,
  tenantId: "tenant_1",
  companyId: "company_1",
  bookId: "primary_book",
  writeSourceId: "native_erp",
  currencyCode: "USD"
});

const dashboard = await sdk.queries.getDashboardSummary({
  periodStart: "2026-01-01",
  asOfDate: "2026-08-12"
});

// Page cards come from the same financial read boundary; routes do not sum a
// paginated table or issue host-local financial SQL.
const invoiceCards = await sdk.queries.getInvoiceSummary({ asOfDate: "2026-08-12" });
const paymentCards = await sdk.queries.getPaymentSummary({
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31"
});
const ledgerCards = await sdk.queries.getGeneralLedgerSummary({
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31"
});
```

Advanced compatibility APIs remain available from the root:

```ts
import {
  ERP_FINANCIALS_STATEMENT_FIXTURE,
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  buildProfitAndLossReport,
  createPostgresStorageAdapter,
  describePackageBoundary,
  renderPostgresSchemaSql
} from "@handrail/erp-financials";

const boundary = describePackageBoundary();
const manifest = POSTGRES_CANONICAL_SCHEMA_MANIFEST;
const sql = renderPostgresSchemaSql(manifest);
// Raw-posting builders are fixture/reference formula helpers.
const profitAndLoss = buildProfitAndLossReport({
  ...ERP_FINANCIALS_STATEMENT_FIXTURE.reportRequest,
  accounts: ERP_FINANCIALS_STATEMENT_FIXTURE.accounts,
  postings: ERP_FINANCIALS_STATEMENT_FIXTURE.postings
});
```

The initial schema foundation exports provider-neutral canonical accounting
types plus a versioned Postgres manifest for host-app installs. The manifest
covers companies, sources, accounts, parties, items, dimensions, transactions,
transaction lines, ledger postings, posting rules, transaction match audit
records, payment applications, import batches, sync checkpoints, and report
snapshot tables. It intentionally stores safe source references and bounded JSON
refs, not provider OAuth tokens or raw unbounded provider payloads.

Posting rules and transaction matching are provider-neutral package contracts.
Host ERP apps supply tenant-specific rule configuration, permissions, and
approval UI. Provider postings that are already authoritative can continue to
bypass local rule evaluation and enter through the source adapter unchanged.

`evaluatePostingRules(...)` evaluates active rules within the transaction's
tenant/source and inclusive effective-date window. Lower numeric priority wins.
If multiple rules match at the winning priority, evaluation returns
`ambiguous` without creating a proposal. Successful proposals use exact integer
cent arithmetic, deterministic half-up percentage rounding, and must balance
debits to credits before they can be returned. Every proposed account is also
required to exist and be active in the canonical chart of accounts supplied to
the evaluator.
See
[docs/transaction-matching-integration.md](docs/transaction-matching-integration.md)
for the host workflow from schema installation and rule configuration through
match decisions, payment applications, and approved proposal-to-ledger writes.
Canonical account hierarchy behavior is provider-neutral and defined in
[docs/account-hierarchy-rules.md](docs/account-hierarchy-rules.md), including
parent postings, descendant totals, inactive parents, invalid parent
references, cycles, cross-source references, nested report line shape,
presentation row hierarchy metadata, drilldown scope, and QuickBooks
source-adapter boundaries.

## Reusable Account And Journal Service

New host applications should use `createErpFinancialsSdk(...)`. Advanced or
existing integrations that only need native accounts and journal entries may
use `createErpFinancials(...)` instead of coordinating individual canonical writes.
The host supplies its Postgres pool or transaction runner once; the service
validates the complete account hierarchy, enforces balanced and active-account
journal postings, creates stable canonical ids, persists every ledger row
atomically, rejects conflicting idempotency-key reuse, and marks affected report
snapshots stale.

```ts
import { createErpFinancials } from "@handrail/erp-financials";

const financials = createErpFinancials({
  database: postgresPool,
  tenantId: "tenant_1",
  companyId: "company_1",
  sourceId: "native_ledger",
  currencyCode: "USD"
});

await financials.fiscalPeriods.define({
  fiscalYear: 2026,
  periodNumber: 8,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  operation: {
    actorRef: "user:123",
    requestId: "request:period-2026-08",
    correlationId: "workflow:year-setup",
    reasonCode: "fiscal_period_defined",
    occurredAt: "2026-08-12T13:00:00.000Z"
  }
});

await financials.accounts.upsertTree({
  operation: {
    actorRef: "user:123",
    requestId: "request:account-tree-1",
    correlationId: "workflow:chart-setup",
    reasonCode: "chart_configured",
    occurredAt: "2026-08-12T14:00:00.000Z"
  },
  parent: {
    accountKey: "service-revenue",
    accountNumber: "4000",
    name: "Service Revenue",
    classification: "income"
  },
  children: [
    {
      accountKey: "setup-fee",
      accountNumber: "4010",
      name: "Setup Fee",
      classification: "income"
    },
    {
      accountKey: "access-fee",
      accountNumber: "4020",
      name: "Access Fee",
      classification: "income"
    }
  ]
});

await financials.journalEntries.post({
  operation: {
    actorRef: "user:123",
    requestId: "request:journal-1",
    correlationId: "workflow:journal-1",
    reasonCode: "reclassification",
    occurredAt: "2026-08-12T15:00:00.000Z"
  },
  idempotencyKey: "service-revenue-reclass-2026-08",
  date: "2026-08-12",
  memo: "Break out service revenue",
  lines: [
    { accountKey: "service-revenue", debit: "100.00" },
    { accountKey: "setup-fee", credit: "30.00" },
    { accountKey: "access-fee", credit: "70.00" }
  ]
});
```

The SDK's `queries` surface provides the corresponding bounded accounting-control
reads. Journal cursors are bound to the reporting book and complete filter set;
fiscal-period and posting-lock reads additionally require the package-owned
source identity so a host cannot accidentally combine controls from two books.

Financial statements, dashboard summaries, General Ledger pages, and General
Ledger summaries accept optional `accountingMethod: "cash" | "accrual"`.
Omission retains the reporting book default. The package owns dual-basis
materialization, snapshot invalidation, and basis-locked drilldowns; see
[cash and accrual reporting](docs/cash-accrual-reporting.md).

```ts
const journals = await sdk.queries.listJournalEntries({
  sourceId: "native_ledger",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  limit: 50
});
const journal = await sdk.queries.getJournalEntry(journals.items[0]!.journalEntryId);

const periods = await sdk.queries.listFiscalPeriods({
  sourceId: "native_ledger",
  fiscalYear: 2026,
  limit: 50
});
const period = await sdk.queries.getFiscalPeriod("native_ledger", periods.items[0]!.fiscalPeriodId);
const postingLock = await sdk.queries.getPostingLock("native_ledger");
```

Journal detail returns exact balanced lines, reporting-book account references,
immutable original transaction identity, preparation/lifecycle provenance, and
reversal/correction/replacement links. Fiscal reads return optimistic versions,
close/reopen provenance, and either external close evidence/checksum or a native
`canonicalCloseCertificateId`. Posting-lock reads return version zero for a book
source whose control has not yet been created.

For SDK-owned accounting, `commands.fiscalPeriods.closeCanonical` revalidates
canonical drafts, balanced postings and configured bank-statement cutoffs under
transaction locks, then closes and captures immutable evidence atomically.
`fiscalCloseCertificates.get/totals/banks` expose the receipt and paginated exact
control totals without direct table access. Persist the readiness `approvalToken`
with the approved request and pass it as `expectedApprovalToken`; the command
rejects changed accounting facts under its transaction locks. See the [canonical close contract](docs/sdk-v1-contract.md#atomic-canonical-fiscal-close-0390--schema36)
for approval, trusted bank configuration, replay and compatibility requirements.

A standard Postgres pool with `connect()` can be passed directly; the package
owns `BEGIN`, `COMMIT`, `ROLLBACK`, and connection release. A host database
library that already exposes transactions can instead supply an
`ErpFinancialsTransactionRunner`, or adapt a pool explicitly with
`createPostgresTransactionRunner(...)`. Authorization and approval decisions
stay with the host; each write carries standardized authorization/audit context
that the package records as an immutable lifecycle event. Snapshot
invalidation is part of the atomic write. The host scheduler should run the
normal rollup and snapshot-refresh workers after a successful result.

Recurring financial intent is available through `sdk.recurring`. It plans
bounded monthly, quarterly, or annual occurrences and materializes typed,
replay-safe commands for invoice drafts, exact-bill payment schedules, and
non-A/P cash-disbursement journals. The host retains recurrence-template
storage, scheduler registration, approvals, and occurrence checkpoints; the
package does not transmit ACH or other payment-provider instructions.

`accountKey` is the recommended app-facing reference: the package derives a
tenant/source-scoped canonical `accountId` from it. Existing integrations may
pass an explicit canonical `accountId` instead.

The first deterministic fixture set exports representative companies, sources,
accounts, parties, items, dimensions, transactions, transaction lines, and
ledger postings. The raw-posting report builders calculate profit and loss,
balance sheet, trial balance, and cash flow from canonical postings as
fixture/reference formula helpers for smoke tests, snapshot refresh/rebuild, and
bounded repair flows. Results emit snapshot metadata, line rows, named totals,
freshness/reconciliation fields, and compact drilldown refs for app UI and
AI-safe report APIs. Cash flow uses cash-account ledger movement and marks
output `partial` when fixture or host data cannot classify a cash movement.

### Bounded cash-flow reporting

`queries.getCashFlowSummary({ periodStart, periodEnd, accountRoles })` returns
exact decimal-string opening cash, operating/investing/financing movements,
unclassified movements, net movement and closing cash. It reads one SQL snapshot
and returns a constant-size summary; it does not collect ledger history in Node.
`accountRoles` is explicit host accounting policy expressed in reporting-book
keys and roles `cash`, `operating`, `investing`, or `financing`. Assignments inherit
to descendants, with the nearest explicit assignment taking precedence. The
policy accepts up to 2,000 configured roots (not a limit on postings).

The read honors book membership/cutover dates, currency and accounting basis.
Cash accounts must be assets. Transfers entirely within selected cash accounts
are excluded from activity categories. Multiple known categories are allocated
exactly from their counterpart amounts only when all noncash movements have the
opposite sign to the net cash movement (for example, loan principal plus interest
paid entirely in cash). This is recorded in `allocatedTransactionCount`.
Mixed-sign noncash categories (for example, equipment partly financed by debt),
unknown counterpart accounts, and unbalanced selected transactions remain
unclassified. The query never allocates proportionally or guesses from names.
`supportStatus: "partial"` is driven by transaction counts, so offsetting unknown
inflows/outflows cannot disguise incomplete classification. These counts must be
reviewed before presenting the summary as a complete cash-flow statement.
The `reconciliation` result exposes `cashLedgerDifference` (opening cash plus
net movement less closing cash) and `classificationDifference` (classified plus
unclassified movements less net movement). Both are exact decimal strings and
are zero only after the SDK's same-snapshot checks succeed; an inconsistent
summary is rejected. Zero differences do not establish complete classification,
bank-statement reconciliation, migration completeness, or provider parity.

This is the direct cash-account-movement method, not an indirect statement or a
provider-parity claim. It does not itself define a company's account policy,
forecast collections, supply line-level drilldown, or certify reconciliation.
The existing raw-posting fixture/reference builders retain their compatibility
behavior; this bounded query is the ordinary-ledger reporting API.

### Correcting native cash purpose

`commands.cashFlow.correctPurpose({ documentId, expectedRevision, operating,
investing, financing, idempotencyKey, operation })` explicitly restates an
erroneous native receipt or bill-payment purpose. Nonnegative exact decimal
amounts must sum to the original cash amount; receipts have one purpose so
partial refunds inherit it exactly. `queries.getCashFlowPurpose({ sourceId,
documentId })` returns the latest approved revision, or null for original
posting/clearing evidence. Revision zero means no correction exists.

The command requires financial approval, native posting evidence in the factory
book, and open fiscal periods for the original cash and every related native
refund/void. It serializes with cash returns and fiscal close, appends immutable
classification/audit/outbox evidence, and invalidates outstanding source close
reviews. It never opens a period, moves money, changes a balance, edits initial
receipt metadata, or replays a provider action. A correction intentionally
restates historical categories once the affected periods are authorized open;
ordinary noncash bill reallocation does not. Original accepted command retries
remain valid; an old correction retry returns its original revision even after
a later correction. Hosts must present a separate reviewed correction workflow,
not call this automatically during bill reassignment or startup. Imported
payments and the older provider-correction workflow are not supported by this
native command. Corrected periods must be reclosed and reports regenerated. If posting accounts
or bill amounts are wrong, use the corresponding financial correction command
as well; a cash-flow presentation correction alone does not repair those facts.

## Postgres Storage Boundary

Host apps provide their own Postgres connection object; this package does not
own database credentials, provider OAuth, or runtime env vars. Any client with a
`query(sql, params)` method can be adapted:

```ts
const database = createPostgresTransactionRunner(postgresPool);
await migratePostgresSchema(database, {
  appliedByRef: "deployment:erp-api-2026-08-12"
});

const storage = createPostgresStorageAdapter(postgresClient);

const validation = await storage.validateSchema();

if (!validation.compatible) {
  console.log(validation.issues);
}

await storage.upsertAccountingCompany(ERP_FINANCIALS_STATEMENT_FIXTURE.company);
await storage.upsertAccountingSource(ERP_FINANCIALS_STATEMENT_FIXTURE.source);
await storage.upsertLedgerPostings(ERP_FINANCIALS_STATEMENT_FIXTURE.postings);
await storage.writeReportSnapshot(profitAndLoss);
```

`migratePostgresSchema(...)` is the production install and upgrade path. It
uses an ordered checksummed ledger, advisory transaction locking, transactional
upgrades, supported legacy-baseline adoption, drift detection, and final schema
validation. `installSchema({ dryRun: true })` remains a development/compatibility
DDL preview and is not the production upgrade path. `validateSchema()` reads Postgres catalogs and
reports missing schema, tables, columns, indexes, constraints, required enforcement triggers, and fixture-loader
support. Fixture loading, rollup writes, freshness writes, and stale snapshot
marking are explicit mutating methods so validation can be run safely against a
host production database.

The idempotent upsert helpers use tenant/source identities from the manifest,
for example ledger postings conflict on `(tenant_id, source_id,
accounting_basis, source_posting_id)`. This lets import jobs reprocess late or
backdated source facts without duplicating canonical postings.

For the complete blank-host install sequence, fixture smoke test path,
scheduled job expectations, freshness checks, and future Handrail capability
validation checklist, see [docs/host-app-install.md](docs/host-app-install.md).
The production accounting integration contract is in
[docs/prime-time-financial-kernel.md](docs/prime-time-financial-kernel.md).
For the worker-facing QuickBooks SDK/service to host-app storage contract, see
[docs/storage-host-app-handoff.md](docs/storage-host-app-handoff.md).

## Supported Adoption APIs

New hosts should treat `@handrail/erp-financials/sdk` as the stable, compact
application contract. The root entry point is supported for compatibility,
provider adapters, storage, migrations, workers, health, and other advanced
kernel use. Direct imports from `src/`, `dist/`, undeclared provider-specific
subpaths, copied package folders, or app-local compatibility shims are unsupported.

The supported adoption surfaces are:

- Cohesive SDK: `createErpFinancialsSdk`, reporting books and their authoritative
  chart, invoice lifecycle, canonical credit/refund register and detail models,
  vendor-bill register/detail/KPIs and posted void/replacement, issued-adjustment
  void/replacement, atomic match-and-apply, bank
  reconciliation, book-aware query/read models, stable typed errors, outbox
  delivery, and `createRuntime`. See
  [docs/sdk-v1-contract.md](docs/sdk-v1-contract.md) and
  [docs/vendor-bill-contract.md](docs/vendor-bill-contract.md).
- Canonical schema, migration, and health:
  `POSTGRES_MIGRATIONS`, `planPostgresMigrations`,
  `migratePostgresSchema`, `validatePostgresMigrationHistory`,
  `POSTGRES_CANONICAL_SCHEMA_MANIFEST`,
  `createPostgresStorageAdapter(...).validateSchema()`,
  `validatePostgresSchema`, `checkErpFinancialsInstallHealth`, and
  `validateFutureErpCanonicalSchemaPreflight`.
- Storage adapter and persistence: `createPostgresStorageAdapter`,
  `createFutureErpCanonicalFactPersistenceWorker`, and
  `persistFutureErpCanonicalFacts`. Host apps should write canonical financial
  facts through the adapter/worker contract and should not bypass it except for
  explicit package-compatible migrations or audited backfills. Core ERP hosts
  can call `buildCoreErpPersistenceEvidence` after persistence, or read the
  `evidence` field returned by the host-neutral QuickBooks workers, to expose
  import batch, checkpoint, canonical row/write counts, freshness, resume
  metadata, and bounded safe source refs through app read APIs.
- Native accounting operations: `createErpFinancials` is the preferred
  package-level API for account trees, journals and their immutable correction
  lifecycle, fiscal controls, receivable/payable/cash documents, issued credit
  and refund void/replacement, and payment applications. It owns validation,
  deterministic ids, idempotency, audit evidence, atomic canonical writes, and
  report-snapshot invalidation after the host supplies a transaction runner.
- QuickBooks normalized mapping: `HandrailQuickBooksSdkResourcesAdapterInput`,
  `mapHandrailQuickBooksSdkResourcesToCanonicalFacts`,
  `mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts`, and
  `mapNormalizedQuickBooksIncrementalSyncResponseToCanonicalFacts`.
- QuickBooks SDK envelope handoff:
  `adaptHandrailQuickBooksSdkFullSyncEnvelope`,
  `adaptHandrailQuickBooksSdkIncrementalSyncEnvelope`, and
  `adaptHandrailQuickBooksSdkSyncEnvelope` accept the public
  `handrail.quickbooks.normalized-sync-envelope.v1` response directly and
  return the ERP Financials worker envelope. The adapter validates tenant,
  realm, and provider identity; preserves checkpoint, delta, completeness, and
  normalization-warning evidence; requires explicit debit/credit posting
  polarity; and marks incremental resources with canonical sync actions.
- QuickBooks sync worker contracts:
  `createQuickBooksFullSyncWorker`, `createQuickBooksIncrementalSyncWorker`,
  `createFutureErpQuickBooksFullSyncWorker`,
  `createFutureErpQuickBooksIncrementalSyncWorker`, the normalized
  full/incremental QuickBooks sync envelope types, and the package-root
  QuickBooks service/client facade including
  `createHandrailQuickBooksFullSyncServiceHandler` and
  `createHandrailQuickBooksSyncClient`.
- Fixture/reference report formulas and persisted report flow:
  `buildProfitAndLossReport`, `buildBalanceSheetReport`,
  `buildTrialBalanceReport`, and `buildCashFlowReport` are raw-posting formula
  helpers for fixtures, smoke tests, snapshot refresh/rebuild, and bounded
  repair flows. `buildReferenceStandardReportPresentationFromFacts` is the
  explicitly fixture/reference-only in-memory standard-report presentation
  helper; `buildStandardReportPresentationFromFacts` remains only as a
  deprecated compatibility alias and is not recommended for production
  presentation. Production standard-report presentation should use
  `buildStandardReportPresentationFromReadModel` backed by snapshots, rollups,
  or SQL aggregates. Persisted reporting flows use
  `buildCoreErpReportFromCanonicalReadModel`,
  `buildFutureErpReportFromCanonicalReadModel`,
  `CORE_ERP_CANONICAL_REPORT_NAMES`, `createSnapshotRefreshContract`,
  `reconcileReportFreshness`, `createFutureErpRollupAndLateArrivalWorker`, and
  `createFutureErpSnapshotRefreshAndFreshnessWorker`. Core ERP hosts should use
  the Core ERP report helper/types for P&L, balance sheet, trial balance, cash
  flow, freshness, rollup bucket, and bounded drilldown read models while the
  Future ERP helper remains as a compatibility alias over the same canonical
  builder path.

The QuickBooks service owns OAuth, token custody, raw provider calls, provider
resource normalization, and tenant/provider access. ERP Financials owns the
provider-neutral canonical schema, storage adapter contract, report formulas,
rollups, snapshots, freshness, and bounded reconciliation evidence. Provider
report data may be used as parity evidence only; it is not the product
reporting source of truth.

## Source Adapters

Provider inputs land in report builders through the same canonical fact set.
The package exports generic adapter contracts plus helper foundations for native
ERP ledgers and QuickBooks SDK-shaped journal entry data:

```ts
import {
  ERP_FINANCIALS_QUICKBOOKS_ADAPTER_FIXTURE,
  mapHandrailQuickBooksSdkResourcesToCanonicalFacts,
  mapNativeLedgerToCanonicalFacts,
  mapQuickBooksJournalEntriesToCanonicalFacts
} from "@handrail/erp-financials";

const nativeFacts = mapNativeLedgerToCanonicalFacts(nativeLedgerInput);
const quickBooksFacts = mapQuickBooksJournalEntriesToCanonicalFacts(quickBooksSdkInput);
const quickBooksResourceFacts = mapHandrailQuickBooksSdkResourcesToCanonicalFacts(handrailQuickBooksResourcesInput);
const quickBooksEvidence = ERP_FINANCIALS_QUICKBOOKS_ADAPTER_FIXTURE.providerReportEvidence;
```

Apps using `@handrail/quickbooks-node-sdk` do not need an app-local accounting
normalizer. Adapt the SDK response at the package seam, then pass the result to
the matching ERP Financials worker:

```ts
import {
  adaptHandrailQuickBooksSdkFullSyncEnvelope,
  createQuickBooksFullSyncWorker
} from "@handrail/erp-financials";

const sdkResponse = await quickBooks.fullSync({ entities });
const erpEnvelope = adaptHandrailQuickBooksSdkFullSyncEnvelope(sdkResponse, {
  sourceId,
  accountingBasis: "accrual",
  currencyCode: "USD"
});

const worker = createQuickBooksFullSyncWorker({
  companyId,
  persistence,
  quickBooksClient: { fullSync: async () => erpEnvelope }
});
```

Use `adaptHandrailQuickBooksSdkIncrementalSyncEnvelope` with
`createQuickBooksIncrementalSyncWorker` for delta/checkpoint-resume imports.
The adapter only reshapes safe normalized SDK data; it does not call Intuit,
retain credentials, or infer accounting postings in the host app.

Both adapters also consume explicit per-record zero-effect dispositions through
the provider-neutral `SourceRecordDisposition` contract. Accepted records are
excluded from canonical projection but remain visible in import warnings,
source provenance, and persistence evidence; malformed, contradictory, or
data-mismatched dispositions fail before persistence. See
[source-record-dispositions.md](docs/source-record-dispositions.md).

For service and SDK boundaries, the package also exports normalized QuickBooks
resource contracts such as `NormalizedQuickBooksResourceSet`,
`NormalizedQuickBooksCompanyInfoResource`, `NormalizedQuickBooksAccountResource`,
`NormalizedQuickBooksLedgerTransactionResource`, and
`NormalizedQuickBooksLedgerPostingResource`. These contracts carry tenant/source
identity, realm/provider environment, sync mode, import batch id, checkpoint id,
source update timestamps, safe drilldown refs, provider report refs, and bounded
reconciliation evidence without exposing provider clients or credential fields.

The QuickBooks helper preserves tenant id, source id, provider environment,
realm id, source object type/id, source update timestamps, import batch ids,
checkpoint ids, and safe source payload refs for idempotency and drilldown. It
expects host apps to fetch provider data through the Handrail QuickBooks
SDK/runtime config. Host apps that receive normalized Handrail QuickBooks
resource wrappers can pass them through
`mapHandrailQuickBooksSdkResourcesToCanonicalFacts`, which validates
realm/environment identity and carries bounded SDK/service source refs into the
canonical facts. ERP Financials does not store Intuit access or refresh tokens
and does not introduce QuickBooks credential environment variables.

`ERP_FINANCIALS_QUICKBOOKS_ADAPTER_FIXTURE` proves the same path with
deterministic QuickBooks-shaped SDK resources: adapter input maps to canonical
facts, those facts build P&L, balance sheet, and trial balance reports, and the
fixture carries bounded provider-total reconciliation evidence with safe
QuickBooks report refs.

`createQuickBooksContractSmokeHarness()` is the local contract smoke harness for
Future ERP adoption. It starts from
`ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync.response.resources`,
adapts the normalized resource envelopes into the
`mapHandrailQuickBooksSdkResourcesToCanonicalFacts` input shape, builds
canonical facts and P&L/balance sheet/trial balance reports, and returns a
compact deterministic snapshot plus SHA-256 hash. The snapshot also records the
ERP freshness row, snapshot refresh contract, monthly rollup summary, and
QuickBooks service-health evidence derived from the normalized fixture boundary.
The harness uses only fixture data and provider report fixture summaries; it
does not require QuickBooks credentials, call Intuit, store Intuit
access/refresh tokens, or retain raw unbounded provider payloads. Cash-flow
reports remain buildable from canonical facts, while QuickBooks provider
cash-flow parity is intentionally documented as unsupported in the deterministic
provider-report fixture.

## Validation

Run the deterministic package checks from a clean checkout:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```

`npm run validate` runs the same commands in sequence for local package
verification.

For targeted schema work, the canonical manifest contract is covered by:

```sh
npx vitest run test/canonical-schema-manifest.test.ts
```

For targeted report-builder work, the deterministic fixture contract is covered
by:

```sh
npx vitest run test/report-builders-fixtures.test.ts
```

For targeted Postgres storage adapter work, run:

```sh
npx vitest run test/postgres-storage.test.ts
```

For targeted source adapter work, run:

```sh
npx vitest run test/source-adapters.test.ts
```

For the normalized QuickBooks handoff smoke harness, run:

```sh
npm run contract:smoke
```

For the reusable install/schema/fixture/freshness/drilldown health contract that
host apps and the future `erp_financials` capability can run without provider
credentials, run:

```sh
npm run health:smoke
```

## Current Scaffold

- `src/` contains the public TypeScript exports for host ERP apps, including
  canonical model types, the versioned Postgres schema manifest, source adapter
  contracts/helpers, deterministic fixture data, report builders, and the
  host-provided Postgres storage adapter.
- `test/` contains deterministic Vitest coverage for the current public API.
- `tsconfig*.json`, `eslint.config.mjs`, and `vitest.config.ts` define the
  lint, typecheck, test, and build path.
- `docs/` remains the implementation contract for the next schema, fixture,
  adapter, rollup, snapshot, and freshness tasks.

### Explicit administrator confirmation

Independent approval remains the default. Trusted server consumers can opt selected
financial actions into `financialApprovalPolicy: { mode: "administrator_direct",
actions, guard }`. The guard must authenticate the active company administrator
and lock an immutable, explicitly confirmed preview in the command transaction.
This supports same-admin imported payment correction and bank-feed ignore while
preserving accounting and replay checks. See the [API, guard/storage contract and
Spartan handoff](docs/administrator-confirmation-sdk-handoff.txt).

`fiscalCloseCertificates.verifyCurrentTotals(certificateId)` compares every
captured account/basis/currency control-total group to the current source ledger
through that certificate's period end. It returns exact string group counts and
`matches` from one PostgreSQL snapshot, without collecting posting history in
application memory. It detects changed opening balances, period activity, and
posting counts; future activity is excluded. This is **only** control-total
agreement, not a current close approval: callers must independently check the
period is still closed with that certificate. It does not certify unchanged
transaction metadata, report chart mappings, bank status, or other book sources.
For a multi-part report, supply one repeatable-read transaction runner so this
check and the report reads use the same snapshot.

### Protecting operational records from reset

`queries.withLockedAccountingReferences({ sourceIds }, async guard => ...)`
coordinates an operational reset with SDK accounting writers. Call
`guard.hasReferences(stableOperationalIds)` in batches of 1–200 identifiers and
perform any operational deletion in the callback's `guard.client` transaction.
The query returns only a boolean; the SDK owns inspection of drafts, documents,
journals, line attribution, scheduled payment instructions, bank lines/matches,
lifecycle and outbox evidence. Settled/voided history
still protects the record. Literal substring matching conservatively includes
legacy composite references and may retain extra records. This is an infrequent
maintenance query, not an indexed report or arbitrary search API.

Sources must belong to the active scoped reporting book. The guard requires one
explicit READ COMMITTED transaction, obtains the same source advisory locks as
native writes (including bank-line ingestion), and takes a fresh snapshot after waiting. Acquire it before host
row/table locks; use bounded lock/statement timeouts. The callback and checks must
finish before commit. Retaining a callback for later use is rejected.

A guard is not a permanent tombstone registry. Host writers must validate the
operational entity and persist its required FK links in the same transaction as
the SDK command, so a writer that follows a completed reset cannot commit orphan
accounting. A failed or uncertain reset must be rolled back and re-previewed;
do not skip the guard or disable financial lifecycle triggers. Shared SQL roles
and arbitrary direct DML are outside this command-level concurrency guarantee.

### Bounded database-wide accounting maintenance

As of 0.3.176, composed host commands may use `SAVEPOINT`, `RELEASE SAVEPOINT`
and a single `ROLLBACK TO [SAVEPOINT] name` with an unquoted simple identifier.
Savepoint recovery also works after a SQL error has aborted the nested command.
The wrapper still owns the outer transaction and connection: whole-transaction
commit/rollback, transaction-control batches and work after expiry are rejected.
A callback failure rolls back all changes, including released savepoints.

`withPostgresAccountingMaintenance(pool, request, work)` owns a dedicated pool
checkout and repeatable-read transaction for a short, explicit maintenance
window. The request must acknowledge `acknowledgeDatabaseWideLock: true`, name
1–200 source identities, and may name up to 200 host-owned relations. It locks
**every SDK table in this database**, including reporting configuration and
schema history, plus those host relations in SHARE mode. This affects all
companies/sources sharing the database. Ordinary readers can continue; other
transactions' inserts, updates, deletes and incompatible DDL wait.

Source command locks are acquired without waiting, before BEGIN. All table locks
are then acquired with NOWAIT before the first transaction snapshot. A busy
source or relation rejects the attempt; there is no retry or partial-success
result. Source locks also allow fiscal and bank proof readers on the same client
to obtain their shared command guards without deadlocking behind waiting writers.
Declare every source whose guarded readers the callback will use.

Use only `guard.client` for the callback's host queries and SDK transaction runner
(`{ transaction: work => work(guard.client) }`). The guard reports the transaction
ID, database-wide scope and locked relation count. The callback may persist a
host proof marker in that transaction; failure rolls it back. Do not open another
transaction, release the client, perform network/gateway actions, or use command
wrappers that require READ COMMITTED inside this scope. Calls after callback
completion are rejected. The deadline defaults to 30 seconds and is capped at
60 seconds. PostgreSQL statement/idle timeouts and connection-error cleanup bound
the lock lifetime; a failed connection is discarded rather than returned with
session advisory locks. Callbacks must still stop their own non-database work.

This is not an authorization service or a security boundary against privileged
raw SQL. The host must enforce maintenance authorization, drain uncertain gateway
operations, freeze the complete host source/intent/link set, validate current
source/archive agreement and prove recovery. A final verification fence does not
provide a durable maintenance mode for a multi-transaction backfill or authorize
cutover. Do not run schema upgrades or change the table catalog during maintenance.

### Canonical journal line evidence

`queries.getJournalPostingPage` returns optional `transactionLineId` and
`transactionLineNumber` on each posting when the SDK has a canonical transaction
line. This includes invoice, receipt and payable journals that have no manual
journal preparation event. The existing scoped, dated, basis/currency-aware
pagination and revision checks apply. Imported postings without canonical lines
remain valid report rows and leave both fields absent.

Migration code must validate explicit event ownership, page controls and exact
line amounts before registering legacy links. A matching line count, amount or
date does not prove ownership. Missing line evidence must stop adoption; do not
query private tables or invent positional identities to fill the gap.

Large native journals retain the 4 KB outbox payload ceiling and the 8 KB lifecycle audit payload ceiling. Journal lifecycle events use the same compact posting locator when their inline evidence exceeds the smaller 4 KB budget, leaving room for JSONB formatting and approval audit. Existing small-event lifecycle payloads remain unchanged. `ledger.posted` keeps its existing `postingIds` list when it fits; otherwise it omits that field and supplies `postingIdsOmitted: true` and the exact `postingCount`. The transaction ID, posting date, accounting basis, currency, and event source scope locate the complete facts through `queries.getJournalPostingPage`. Consumers must not interpret an omitted list as no postings or fabricate a partial list. Command results still return every posting ID; retrying a command does not enqueue a second event.

`queries.listJournalEntries` accepts `sourceTransactionId` only with `sourceId` and `transactionType`. It is an exact immutable source identity filter (including literal whitespace, `%`, and `_`), not document-number or fuzzy matching; it restricts the canonical transaction query before journal detail joins and participates in cursor binding. Ordinary unfiltered paginated reads remain compatible. For native manual journals use transaction type `JournalEntry`; subledger journals remain available through the general journal posting APIs, not this manual-journal list.

Native payment application commands now snapshot caller input before asynchronous work and retain versioned command identity in their applied lifecycle event. A retry must preserve the original actor, approver, reason, expected source/target versions, scope and business payload; a fresh transport request/correlation ID is allowed. Historical applications without this retained command evidence remain queryable, but attempting to replay them fails with `unsupported_operation`. Reconcile their existing application/lifecycle facts explicitly; do not invent original optimistic versions, rewrite audit history, or choose a new key to force another application.

An existing atomic bill-payment completion receipt can still be replayed through its parent command: that immutable instruction already retains the original ordered allocations and expected bill versions. The SDK verifies that parent evidence and each child's audit identity; it does not infer original versions from current balances or reopen ended applications.

`queries.findPaymentApplicationByKey({sourceId, idempotencyKey})` performs a bounded exact lookup in the reporting book and returns current application state with the retained original expected source/target versions. It returns `null` for no scoped command, and `originalExpectedVersions: null` for historical receipts without those fields. This evidence only composes a retry: the native apply command still verifies its full checksum, actor, scope and lifecycle. Never treat the lookup as posting authorization, adopt an amount/date match, or use a fresh key to recreate a historical command.

`queries.findBillPaymentCommandByKey({sourceId, idempotencyKey})` returns the native instruction's original ordered allocation amounts and optimistic bill versions, together with current disbursement status/version. It reads one exact scoped key and requires the original posting-book provenance; a matching customer/vendor, amount, date or reporting-source membership does not confer command ownership. Book eligibility and the receipt share one SQL snapshot. Use this evidence to compose a retry through `commands.billPayments.recordAndApply`, which still validates the complete payload, actor and lifecycle. No current application-history scan or mutable current bill version can substitute for this instruction.

`queries.findBankMatchCommandByKey({sourceId, idempotencyKey})` reads an exact, scoped match instruction and its current lifecycle in one bounded SQL statement. It returns `originalExpectedVersion: null` for historical matches lacking original optimistic-version evidence. The original match event is used even after unmatching changes the current lifecycle pointer. Compose retries with that original version; the native command still validates scope, complete business payload, actor, approver, reason and lifecycle. Historical matches remain reportable, but replay without retained command evidence fails with `unsupported_operation`; review ownership rather than inventing a version or choosing a new key.

Bank ingestion, matching and disposition commands capture caller input before asynchronous work and use command savepoints, including when a host catches an error inside a larger transaction. Ingestion and unchanged match/unmatch/ignore retries permit fresh transport metadata while retaining the original audit receipt. `unignore` retains its existing request-ID command identity: retry it with the original request ID, version and operation. Ended matches cannot be reopened by replay. These commands do not move money through a bank or payment gateway.

`fiscalCloseCertificates.verifyClosedState(certificateId)` verifies both exact control totals and whether that certificate remains the current closed period version/event. Unlike `verifyCurrentTotals`, a reopened period does not pass merely because its balances are unchanged. The result includes the immutable bank completion evidence references captured by the close. The method holds the SDK source posting guard and period/book row locks through the explicit caller transaction; bind it to the same transaction as host migration-link finalization. It does not close/reopen a period or grant approval. Missing scope or inactive books fail; a changed lifecycle or totals returns `matches: false`. Historical certificates remain readable after reopening.

`bankStatements.selection({statementId, limit, cursor})` pages only the statement's selected clearings through its existing statement/date/posting index. It exposes scoped canonical transaction-line IDs when available, validating that each posting belongs to that transaction and account. Imported facts without canonical lines leave the ID absent; callers must not infer ownership. Cursors bind to the statement version and scope. This lets migration compare exact reviewed line identities and amounts without collecting all outstanding bank history or issuing one detail query per posting. It neither prepares nor completes a statement.

Large invoice and other native subledger postings retain their complete, ordered account-policy audit requirements in immutable `journal.account_policy.recorded` lifecycle chunks when the inline policy exceeds 2 KiB. The posting event retains `executionAccountPolicy` with the version, requirement/chunk counts, SHA-256 checksum and exact chunk-key prefix. Small policy payloads retain the existing `executionAccountRequirements` field. The policy chunks, posting, lifecycle root and outbox commit or roll back together; exact command replay reuses the original evidence.

Use `queries.getJournalAccountPolicyPage({sourceId, transactionId, limit, cursor})` to read this evidence without SDK-table access. `limit` counts chunks (default20, maximum100), each containing bounded ordered requirements; the API also supports historical inline policies. Concatenate requirements in page/chunk order and compare the returned count and SHA-256 of `JSON.stringify(requirements)` with the root metadata for complete-export verification. The cursor is bound to tenant, company, book, source and transaction; source membership is evaluated at the journal date and locked during each read. No configured policy returns an empty collection. This API exposes historical execution evidence, not current posting eligibility. It does not fetch posting lines or scan full accounting history. An individual account-policy record larger than2 KiB fails validation; aggregate policy growth is paged without a total-entry cap.

Bank-line ignore replay checks the original versioned command receipt before current-state eligibility. After a later reopen, retrying the old ignore returns `idempotency_conflict` and leaves the current state, audit and outbox unchanged; it never becomes a new ignore command.

### Operational customer/vendor registration

`sdk.commands.parties.ensureActive({ partyId, sourcePartyId, partyType, displayName, operation })`
registers a new customer or vendor inside the SDK transaction and records a
`party.registered` lifecycle event. Existing source identity, party type, name
and accounting active state are preserved. A changed identity/type fails with
`scope_mismatch`; an inactive party fails with `missing_party`. Operational
name changes do not change accounting master data. This is an identity-based
ensure operation, not a master-data update or a party-reactivation command.

Concurrent first registration uses the unique source-party key. The command
holds a shared row lock through transaction completion so a concurrent non-key
active-state update cannot race the caller's subsequent posting. Bind the SDK
to the same database transaction as the invoice/receipt/payable workflow.
New registration and its audit record roll back together. Identity/name fields
are bounded to 512 characters. Import storage upserts retain their existing
semantics for explicit imports; ordinary application commands must not use
them to overwrite accounting-party eligibility.


### Contractual invoice dates and accrual recognition

From 0.3.159 (schema 46), `commands.invoices.create` accepts optional
`recognitionDate`; `date` remains the contractual invoice date. Omitting it
preserves the previous one-date behavior and idempotency identity. The SDK
posts the accrual journal on recognition, preserves the contractual due date,
and uses recognition for financial as-of inclusion and reporting-book source
membership. Invoice detail/register and customer-statement rows expose a
`recognitionDate` only when it differs from `documentDate`. Register pagination
continues to order by contractual date; aging buckets continue to use due date.

`commands.invoices.correctDates` also accepts `recognitionDate`. For an invoice
whose dates differ, callers must supply it explicitly so a due-date or
contractual-date edit cannot silently restate recognition. Changing only the
contractual date leaves postings unchanged; changing recognition reverses the
previous recognition and posts its replacement, with existing approval,
fiscal-period, optimistic-version, atomicity and idempotency guards. Legacy
one-date callers retain their previous correction semantics. Cancellation may
not precede recognition. Invoice applications cannot precede recognition; cash
may be recorded earlier and held unapplied. Date restatement cannot move
recognition after any historical invoice application, including an ended one,
because that would detach historical allocation balances from the GL. Use the
explicit economic correction workflow for that change. This does not authorize historical import of inactive
parties/accounts or relax any approval/hold/period gate.

Schema 46 adds a nullable date without rewriting existing document history.
Existing nulls retain the one-date meaning. Deployment still requires the
normal migration pipeline and host cutover/recovery validation. Dedicated
million-entry performance measurements for the recognition-aware queries remain
required before claiming scale acceptance.

From 0.3.160, invoice economic-correction review also returns the optional
`recognitionDate`, binding the distinction into its review token. A replacement
remains a new sale on the explicitly requested correction date; it does not
rewrite the cancelled invoice’s historical recognition or move existing cash.

`commands.customerPayments.recordAndApply` accepts optional `applicationDate` separately from the cash receipt `date`. It defaults to the cash date for existing callers. Explicit later allocation retains the original cash journal date, is bound into composite-command idempotency, and shares the receipt transaction: invalid or closed application dates roll back the receipt as well. An explicit same-day date retains the prior checksum/replay semantics. Allocation cannot precede receipt or invoice recognition. This command records new cash only; allocating an existing receipt requires `commands.paymentApplications.apply`, never a second collection.

From 0.3.180 (schema 49 unchanged), `commands.customerPayments.retireCollectionAttempt({command, operation})` resolves a user-abandoned, uncertain **native invoice collection**. Supply the exact original `recordAndApply` command, including its actor, versions, accounts, dates, reason and key, plus an independently audited retirement operation by the same actor. It acquires the same source/command locks as posting. If collection committed, the response is `already_recorded_and_applied` with the original receipt; no refund or reversal occurs. Otherwise it writes an immutable `customer_payment.collection_retired` event, returns `retired` (or `already_retired` on replay), and rejects every delayed collection or raw receipt using that key. Retirement does not change accounting balances, fiscal periods or holds. It requires the invoice's original customer/source/book provenance; independently recorded cash under that key is a conflict requiring reconciliation, never evidence of no payment. Changed payloads or retirement reasons cannot reuse the command receipt. Recover a lost retirement response with the exact same retirement request before clearing client recovery state. Persist client attempts before dispatch; this API does not itself provide browser storage or automatic recovery, and it cannot cancel an external gateway transaction.

From 0.3.181 (schema 49 unchanged), `commands.paymentApplications.retireReceiptAttempt({command, operation})` provides the same terminal recovery for a native `customer_payment_to_invoice` allocation. It accepts the exact original `apply` command and a separate same-actor retirement operation. Under the same source/application locks, it either returns `already_recorded` with the existing application's current `already_applied`, `unapplied` or `voided` state, or writes immutable retirement evidence and fences later `apply` calls using that key. It never un-applies, re-applies, refunds, creates cash or changes balances. Unrecorded retirement verifies both documents' native book/source/customer/currency provenance without depending on current balance, version or open fiscal-period state. Original versions remain part of the replay checksum. Changed commands, actors and retirement reasons conflict; historical applications without original command evidence fail closed for reconciliation. This capability is limited to native customer-receipt allocations and is not a general cancellation API for other application kinds or external providers. A missing lookup result alone is not proof that an in-flight allocation cannot still commit. Persist the exact client command and cancellation mode before dispatch; clear client state only after matching terminal evidence.


From 0.3.162 (schema 47), customer-payment allocations cannot precede the source receipt date. The public application command validates this under the existing document locks; a database insert trigger also enforces it, including direct adapter writes. Invoice recognition and fiscal-period checks still apply separately. Migration adds the guard without modifying old facts; historical early allocations require explicit migration reconciliation and must not be treated as correct merely because schema validation passes. Existing exact command replays remain recoverable.

`queries.listUnappliedCollectionReceipts({sourceId, customerId, collectionRef, limit, cursor})` returns current available receipt amounts and versions in a single indexed, book/currency-scoped query. It uses live keyset pagination (maximum 200), never a whole-history list or per-row detail fanout. Cursors are bound to tenant/company/book/source/customer/collection. Refresh after changes; this list is not a reservation or historical statement, and allocation must validate receipt and invoice versions transactionally.

From 0.3.163 (schema 47 unchanged), `queries.findVendorBillHoldCommandByKey({sourceId, idempotencyKey})` retrieves one original hold/release receipt and its optimistic version. It checks tenant/company, active reporting book, source date membership, currency and the bill’s actual posting-book provenance. A later release does not overwrite this receipt. Use the retained version only to replay the exact original command; separately verify current bill controls before treating a historical hold as current. This query neither changes a hold nor authorizes a release.


From 0.3.164 (schema47 unchanged), `queries.getOutstandingDocumentSummary({asOfDate})` returns scoped gross outstanding and overdue invoice/bill counts as decimal strings in one PostgreSQL snapshot, plus its observation time. Due dates equal to `asOfDate` are not overdue. Held bills remain obligations; drafts and unapplied cash/credits are excluded. Historical settlement and corrections use the same rules as the accounting aging queries. This bounded result does not fetch documents or scan GL history. It is a read, not posting/collection authorization.

From 0.3.165 (schema47 unchanged), `queries.listPayments({paymentType:"customer_payment"})` includes the optional native `collectionRef` on each receipt. This permits paged reconciliation of operational collection ownership without per-receipt detail requests or private-table reads. Untagged receipts and bill payments omit it; amounts, refund state, book scope and pagination are unchanged. The reference is identity evidence, not collection or release authorization.

From 0.3.169 (schema47 unchanged), `queries.listBillPayments` selects and
materializes the filtered keyset page before counting its active applications.
`queries.listPayments` likewise computes returned amounts and application counts
only for the selected page when no status filter is requested. Status-filtered
payment queries must still evaluate refund evidence to decide membership before
LIMIT; cursor, date, type and vendor predicates apply at the document stage.
Both paths return the same lifecycle fields, exact amounts and pagination
contract, with one SQL query and no per-row application network requests. This
bounds application enrichment to the page plus one lookahead row; it does not
claim that source document selection or every status filter is constant-time.

From 0.3.166 (schema47 unchanged), `queries.getCurrentVendorBillPage({sourceId,limit,cursor})` reads current native/imported bill balances and holds for one source in the active reporting book. It includes future-dated bills and uses current settlement state, with no historical cutoff or application-history aggregation. Terminal bills remain visible. Pages follow canonical bill ID order using the existing source-scoped key index; cursors bind tenant/company/book/source; readers requiring a consistent complete scan must share one repeatable transaction or an accounting write fence across pages. This read does not authorize settlement, release a hold or replace historical reporting.

### Exact source account control balances (0.3.167)

`queries.getSourceAccountBalanceSummary({sourceId, accountIds, accountingMethod?})` accepts 1–200 distinct canonical source account IDs. It returns debit, credit, signed debit-minus-credit net and posting counts as strings, including future-dated postings within the book's source binding. It uses exact source accounts without reporting mappings or descendants. Missing/out-of-book accounts fail; sub-cent facts are rejected instead of rounded. Inactive account metadata remains readable. Each batch uses one SQL snapshot; multi-batch reconciliation must provide a shared repeatable transaction or write fence. This is a read API, not posting authorization or a subledger reconciliation certificate.

From 0.3.170 (schema 48), payment readers have ordered tenant/company/currency
indexes for document and disbursement page selection. Bill payments select up
to one page plus lookahead from each disjoint source before joining vendor and
document presentation fields, then merge those bounded candidates into the
global page. All source/book/date/status/vendor/method/cursor filters and
duplicate suppression apply before each branch limit. Partial/unapplied/voided general-payment filters use exact native balances;
returned/applied filters retain refund evidence for zero-open candidates.
Selective filters or excluded
source dates can still require scanning additional candidates. No constant-time
guarantee is implied. The additive index migration changes no financial facts;
its transactional index construction needs a planned maintenance window on a
large existing database. The opt-in `test/payment-pages-scale.postgres.test.ts`
uses disposable PostgreSQL only and defaults to 10,000 payments (40,000 ledger
entries). Larger runs require applicable validation admission; the harness's
240-second timeout is not evidence of million-entry readiness.

### Current invoice-line reconciliation pages (0.3.171)

`queries.getCurrentInvoiceLinePage({ sourceId, provenance: "draft" | "posted", limit, cursor })`
returns canonical commercial-line IDs, invoice IDs/versions and exact line economics
in invoice-ID/line-number order. Each page is bounded (maximum 200); no per-invoice
detail fanout is needed. Scan both lanes: the draft lane excludes issued drafts,
and the posted lane includes their canonical documents. Voided and future-dated
invoices remain visible when included by the reporting book's source effective dates.

Cursors bind tenant/company/book/source/lane and cannot be reused across them.
They do not freeze a snapshot. Reconciliation must run both lanes and all pages
on one caller-owned repeatable snapshot, with the appropriate maintenance fence
for cutover. This read-only API neither authorizes cutover nor proves source ownership.
Existing line-order indexes are available; no schema migration is added. Bounded response
size is not a million-entry latency guarantee; book/source selectivity can affect work.

### Durable database-wide accounting maintenance (0.3.172 / schema 49)

`changePostgresAccountingAccess(client, command)` changes maintenance admission
inside a caller-owned transaction. The command requires explicit database-wide
acknowledgment, an expected revision, a payload-idempotent command key and a
validated financial operation context. `pause` returns an opaque session ID;
`resume` requires that exact active ID and current revision. Both changes and
immutable operation receipts commit together. Admitted readers and guarded writers
cause a nonwaiting conflict. A replay returns the original receipt, **not current state**;
use `readPostgresAccountingAccess(client)` to inspect the latter.

Schema 49 installs statement guards on all 51 existing SDK tables, including
TRUNCATE. Ordinary writes fail while maintenance is active, including writes
from older consumers that have not adopted the new API. Read-committed writes
use a shared advisory lock without a shared tuple lock on a hot control row.
Stale repeatable-read writers must serialize or fail; they cannot use an older
open-state snapshot to bypass a pause. Maintenance does not expire automatically.

Hosts must wrap **every financial reader and command runner** with
`withPostgresAccountingAccess(runner)` to stop new reports from observing a
partial store. The explicit migration runner uses
`withPostgresAccountingAccess(runner, { sessionId })`. Session configuration is
transaction-local and restored after the callback. Existing repeatable-read
reports may finish on their consistent pre-pause snapshot; new snapshots see
maintenance. Unwrapped legacy SELECT callers are not blocked by write triggers.
Read-only transactions are supported by the access wrapper. This wrapper is
opt-in so a host must complete its reader inventory before declaring a cutover.

The host remains responsible for current operator authorization, stopping and
reconciling external gateway dispatch, guarding host-owned data, archival and
restore proof, and performing final verification and release in one controlled
transaction. The session ID does not grant user permissions or production SQL
approval. These APIs neither post accounting entries nor certify a migration.
Install schema 49 before enabling the wrapper; it fails closed if control state
is unavailable. This release has no automatic startup pause, backfill or resume.

### Statement batch planning (0.3.175)

`queries.getFinancialStatements` exposes its validated window count (1–36) to
PostgreSQL's planner. This avoids the fixed 100-row estimate for JSON recordsets
and unnecessary high-cost JIT compilation of correlated statement queries.
The public API, one-statement snapshot, exact amounts and arbitrary date-band
semantics are unchanged; no connection or database tuning is applied.

An isolated PostgreSQL 15.19 comparison over 500,000 journals / 1,000,000
postings measured fourteen-statement batches at 3.9–4.3 seconds, versus 5.6–5.9
seconds before this change. Both runs verified exact controls while four writers
posted 400 journals and four readers requested statement batches, with accounting
access and host-table guards enabled. This is synthetic workload evidence, not a
production latency guarantee; the aggregate sort still spills at 4 MiB work_mem.

### Host source tables during accounting maintenance (0.3.174)

A host can explicitly call `installPostgresAccountingHostGuards(client, {
acknowledgeDatabaseWideMaintenance: true, relations: [{ schema, table }] })`
in a caller-owned transaction. This installs statement guards for insert,
update, delete and truncate on the reviewed host tables. The guards use the
same durable pause and explicit session as SDK writes, including old host
writers that do not use a transaction wrapper. Installation requires idle
SDK access and nonwaiting exclusive table locks. Exact existing guards are
preserved; missing guards are installed, while disabled or conflicting guards
are rejected for explicit repair review. Failure must roll back the transaction.
`verifyPostgresAccountingHostGuards` inspects the exact declared set without
repairing it and can run while accounting is paused.

The set is limited to 1–200 distinct ordinary non-inherited host tables;
partitioned/inherited tables and system/SDK schemas are rejected. The host must
choose its complete source set, authorize the operator, drain external effects,
preserve incoming provider evidence and enforce production approvals. The SDK
does not infer those policies. Keep authorization, recovery controls and any
external evidence inbox available as appropriate. Wrap the entire authorized
migration transaction (including host links) with an explicit maintenance
session; wrapping individual SDK calls alone cannot authorize later host writes.

This API neither pauses nor resumes accounting, and creates no cutover grant.
It is an explicit setup operation, not an automatic startup repair. Raw SELECTs,
privileged DDL and replica-role bypass are outside the write guard. Freeze DDL
and revalidate the full host catalog and guards during the actual cutover.

As of 0.3.177, `queries.getOperationalAccounts({sourceId, accountIds, asOfDate})`
returns metadata for 1–200 distinct source-account IDs in the caller's order.
The entire batch rejects when any account is missing or outside the book/source
membership on that date. Inactive accounts remain readable for historical review.
It reads no balances, applications or ledger history and grants no posting
permission; commands still revalidate accounting policy. Use bounded batches for
commercial-line approval labels instead of per-line queries or whole-chart scans.

`queries.getCustomerStatement` in 0.3.178 adds `balance` in the same SQL snapshot
and revision as its bounded invoice page: gross `invoiceOutstandingAmount`,
positive `unappliedCashAmount` and `unappliedCreditAmount`, and signed
`netReceivableAmount`. Existing `totals`/`pageTotals` remain invoice-only for
compatibility. An empty invoice page does not imply a zero customer balance.
`customerExists` and optional `customerName` identify a scoped canonical customer
without requiring an invoice. Missing `balance` on an older SDK is unavailable,
not zero. Historical balances reuse aging's effective application, cash-return,
void and recognition rules, scoped to this customer before aggregation; there
is no host ledger scan, per-invoice detail fanout or second balance authority.
These controls are subledger AR, not proof that unrelated manual GL entries have
been reconciled, and do not authorize a refund or customer release.

### Bounded invoice summaries for customer-owned order links

`queries.getInvoiceSummariesByIds({ invoiceIds, customerId, asOfDate? })` (0.3.179)
reads at most 200 unique, nonempty invoice IDs in one customer/book scope. It
returns found invoices in request order, including draft and voided states;
missing, foreign-customer and out-of-book identities are omitted. An empty batch
returns an empty array. Callers that require every linked document must reject
missing results rather than infer that no invoice exists.

The result uses `InvoiceRegisterItem` without optional memo enrichment. It shares
the register's current status and settlement interpretation, but reads no invoice
line detail, application history, or whole-register totals. `asOfDate` selects
current overdue labels; this is not a historical balance query. Header, cash,
credit, write-off and cancellation amounts share one SQL snapshot. A reporting
book configuration change between validation and the query fails explicitly.
Use the settlement breakdown to distinguish cash payment from noncash settlement;
a zero open amount alone does not establish that cash was received. Hosts own
customer authorization and presentation, and must not expose draft/internal
content simply because this scoped SDK query can return it.

From 0.3.182 (schema 49 unchanged), `commands.billPayments.retireRecordingAttempt({command, operation})` resolves an uncertain **immediate** `recordAndApply` attempt. Supply the exact original command (including ordered allocation versions) and a separate same-actor retirement operation. Source/instruction locks serialize it with immediate, raw and scheduled writes using the same key. If no instruction or independent raw payment exists, the command checks the original vendor bills' native vendor/currency/book/source provenance and appends immutable retirement evidence; future SDK recording/scheduling under that key conflicts. Current holds, bill versions/balances and closed fiscal periods do not prevent retirement. Retry transport timestamps and request IDs may change; changing the original payload, actor, approver, accounting reason, or a saved retirement reason conflicts.

If immediate recording already committed, this API validates its retained native clear, journal and application evidence and returns `already_recorded`, the original payment/journal/application identities, amount/currency and the **current** native payment `paymentStatus` (`cleared` or `voided`). Original applications may since have been released or reassigned; this result never reapplies them. It adds no financial/audit writes on this branch, including after fiscal close or a later void. Regular `recordAndApply` terminal-state behavior is preserved. Direct `void`/`voidIssued`/`voidPosted` after explicit unapplication now atomically marks an associated cleared instruction voided as well as reversing the payment, so those paths no longer leave contradictory instruction state. The composite `voidAndUnapply` continues to own its compensation event. Historical instances of that inconsistency are reported from native payment evidence without being rewritten during recovery; include them in approved migration/reconciliation, not startup repair. A separate schedule/clear/cancel workflow and independently recorded raw payment must be resolved through their own lifecycle; this API cannot silently cancel or adopt them. A missing lookup alone is never permission to forget a pending command. Hosts must persist the frozen command and recovery mode before transport, bind it to the authenticated actor and scope, and clear it only after matching terminal proof. This is accounting command recovery, not authority to cancel, repeat or resolve an external bank/provider transfer.


### Uncertain bank statement commands

From 0.3.183 (schema 49 unchanged), `sdk.bankStatements.retireCommandAttempt({command: {action, input}, operation})` safely resolves an uncertain `prepare`, `complete`, `reopen`, or `cancel` command. `input` is the exact original SDK command, including its operation actor, reason, expected version, key, exact amounts and bounded selection deltas; `operation` identifies the same actor's separate cancellation decision. Hosts must authenticate and authorize that actor before every call.

An accepted command returns `status: "already_recorded"`, its immutable original `statement` receipt and a separate `currentStatement`. Recovery does not execute the command again or replace the original outcome with the current status. An unaccepted command returns `retired`; identical retirement retry returns `already_retired`. The immutable lifecycle event occupies the original command key under the same source lock. All later attempts under that key, including old SDK statement writers, conflict. This does **not** cancel an existing statement, reverse a completion or change clearings. Use the ordinary independent statement lifecycle for those actions.

Retirement verifies original account/book/source provenance without requiring the old fiscal eligibility or expected version still to hold. Changed original content, actor or saved retirement reason conflicts. Transport request IDs and timestamps may change. Freeze a pending command and cancellation mode durably before sending; never discard an unresolved command locally or switch it back to execution after choosing cancellation. This API adds no ledger or balance model and requires no schema migration.


### PostgreSQL connection failures

From 0.3.184, a pool passed directly to `createErpFinancialsSdk` uses the same transaction boundary as `createPostgresTransactionRunner` and the command service. The boundary handles checked-out `node-postgres` connection errors, rejects before commit when a connection has failed, preserves the original command or uncertain-commit error if rollback also fails, and discards failed connections through `release(error)`. It does not automatically retry commands. Recover an uncertain commit with the original payload and idempotency key.

Custom pool clients may still provide only `query` and `release`. To support asynchronous connection errors, expose both `on("error", listener)` and `off("error", listener)`, and honor the optional error/discard argument to `release`. Existing listeners are preserved. Caller-owned transaction runners remain caller-owned: their implementations must handle their own connection failures, rollback and release; the SDK does not replace them or start an independent transaction inside them.

### Resolve an uncertain vendor-bill hold or release

From 0.3.185 (schema 49 unchanged), `sdk.commands.vendorBills.retirePaymentHoldAttempt({command, operation})` resolves an uncertain `setPaymentHold` attempt. Supply the exact original command, including its expected bill version, hold/release value, reason, key and actor/audit evidence, plus a separate same-actor retirement operation. The host must authenticate and authorize the current caller.

If the command was accepted, the result is `already_recorded`: `receipt` retains the original hold/version and lifecycle event while `current` describes the present hold/version. Later release, settlement or fiscal close does not turn historical acceptance into an unaccepted command. Recovery performs no accounting change. If the command was not accepted, `retired` records an immutable fence under the **original** lifecycle key; a delayed setter, including a pre-upgrade implementation, rejects that key. Exact cancellation retries return `already_retired`. The original command and cancellation reasons are separately payload-bound. A changed actor, scope, version, business payload or cancellation reason conflicts.

Cancellation checks native bill provenance (tenant/company/source, posting book and currency), but does not require the original version, open balance or fiscal period still to be current. It changes no hold, subledger balance, journal or outbox event. The source/key locks serialize execution and cancellation; a savepoint rolls back an interrupted cancellation even when a host catches its error inside a larger transaction. An uncertain commit must be retried with the same saved command and cancellation operation. Never restore execution mode after requesting cancellation, and never treat a missing search result or a current bill status as proof that the original command was unaccepted.
