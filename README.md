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
close/reopen provenance, the canonical close evidence and checksum, and version
zero for a book source whose posting-lock control has not yet been created.

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
