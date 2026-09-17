# Handrail ERP Financials Docs

This repository is the reusable financial reporting kernel for ERP-style apps.
It exists so each new ERP app does not have to rediscover schema, migrations,
rollups, financial statements, freshness handling, and report drilldown from
scratch.

The intended shape is:

```text
source adapters -> canonical accounting facts -> rollup/snapshot engine -> report APIs -> app UI and AI tools
```

QuickBooks is the first source adapter, but it must not be the only source. A
fresh-start ERP app should be able to write native accounting facts into the
same canonical model.

## Documents

- [deposit-reversal-contract.md](deposit-reversal-contract.md): Independently
  approved native deposit reversal, immutable identity, dual-basis postings,
  canonical linkage, retry behavior and ERP dependency adoption handoff.
- [blu-adapter-contract.md](blu-adapter-contract.md): Supported BLU-to-SDK
  scope, identity, cents/decimal, command, read, ownership, QuickBooks, and
  pre-v1 adoption boundary, traced to the public BLU consumer harness.
- [sdk-v1-contract.md](sdk-v1-contract.md): Preferred pre-v1 host integration,
  reporting-book/source identity, book chart, invoice lifecycle, matching,
  currency, read models, errors, outbox runtime, and compatibility contract.
- [cash-accrual-reporting.md](cash-accrual-reporting.md): Report-time method
  switching, native dual-basis projections, manual-journal policy, basis-aware
  invalidation/drilldown, and historical QuickBooks backfill.
- [architecture.md](architecture.md): System boundaries and package ownership.
- [canonical-data-model.md](canonical-data-model.md): Tables and domain facts
  this package should standardize.
- [transaction-matching-integration.md](transaction-matching-integration.md):
  End-to-end host integration for posting-rule evaluation, payment-to-invoice
  candidate generation, append-only decisions, payment applications,
  proposal-to-ledger orchestration, idempotency, and concurrency controls.
- [account-hierarchy-rules.md](account-hierarchy-rules.md): Provider-neutral
  canonical account hierarchy rules for parent postings, descendant rollups,
  inactive accounts, invalid parent references, cycles, and source-adapter
  boundaries, plus nested report line shape, presentation row metadata,
  drilldown scope, and QuickBooks non-inference constraints.
- [rollups-and-snapshots.md](rollups-and-snapshots.md): Performance strategy for
  P&L, balance sheet, cash flow, expenses, and drilldown.
- [quickbooks-boundary.md](quickbooks-boundary.md): How this package should
  consume the existing QuickBooks integration without owning OAuth or tokens.
- [source-record-dispositions.md](source-record-dispositions.md): Strict,
  provider-neutral zero-effect disposition validation, projection bypass,
  provenance, retry, warning, and reconciliation-evidence contract.
- [storage-host-app-handoff.md](storage-host-app-handoff.md): Worker-facing
  contract between QuickBooks SDK/service output, host-app orchestration, and
  ERP Financials canonical storage. This is the normalized QuickBooks handoff
  runbook for full/incremental sync usage, checkpoint semantics, provider
  report reconciliation, Future ERP adoption, safe drilldown refs, prohibited
  credential/raw-payload boundaries, and validation commands.
- [source-import-reset.md](source-import-reset.md): Transaction-client-scoped,
  source-isolated clean retry that preserves identity, reporting configuration,
  native/post-cutover facts, OAuth, and credentials.
- [future-erp-dependency-handoff.md](future-erp-dependency-handoff.md):
  Reproducible local dependency/link setup for Future ERP, exact targeted
  validation commands, SDK/service package expectations, adoption flow, and the
  no-token/no-raw-provider-payload checklist.
- [future-erp-scheduler-handoff.md](future-erp-scheduler-handoff.md):
  Future ERP scheduler job names, expected cadence, package APIs, retry
  behavior, evidence fields, and separately gated config/deploy work.
- [operations-runbook.md](operations-runbook.md): Source-level operations
  runbook for QuickBooks full/incremental sync retry evidence, normal rollup
  cadence, wider late-arrival overlap, stale snapshot refresh retry, freshness
  reconciliation, fixture smoke interpretation, drilldown health failures,
  credential-boundary checks, deterministic commands, evidence fields,
  forbidden credential/raw-payload evidence, and escalation points.
- [cross-repo-local-link-validation.md](cross-repo-local-link-validation.md):
  Exact local package link/install commands and deterministic validation order
  for ERP Financials, Handrail QuickBooks Integrations, and Hitcents Future
  ERP, with live sandbox execution gated by Handrail-managed configuration.
- [production-blocker-matrix.md](production-blocker-matrix.md): Sidecar
  blocker matrix for live QuickBooks credentials, production data,
  staging/production deploy changes, scheduler/runtime registration, and formal
  `erp_financials` capability creation.
- [future-erp-surface-inventory.md](future-erp-surface-inventory.md): Inventory
  of the named Future ERP QuickBooks/reporting modules, expected ownership, and
  replacement points for duplicated formulas before dependency wireup.
- [package-export-surface-audit.md](package-export-surface-audit.md): Public
  export-surface compatibility audit for ERP Financials, Future ERP import
  fixtures, QuickBooks mapping, sandbox replay, workers, health checks, and
  safe drilldown refs.
- [host-app-install.md](host-app-install.md): How a blank host app installs the
  package schema, loads fixtures, runs validation, registers jobs, checks
  freshness, and consumes report APIs.
- [handrail-capability-plan.md](handrail-capability-plan.md): How a future
  Handrail capability should install, configure, and validate this package.
- [adoption-roadmap.md](adoption-roadmap.md): Practical path from Future ERP to a
  reusable package.

## Core Decisions

- Do not clone the first ERP app as the reuse mechanism.
- Do not depend on KB-only instructions and AI reimplementation for migrations.
- Keep provider integrations separate from the financial reporting kernel.
- Make this package own canonical schema manifests, report builders, rollup
  jobs, report snapshots, fixtures, and acceptance tests.
- Use a Handrail capability as the distribution and validation mechanism, not as
  the home for ERP financial domain logic.

## Current Host-App Path

A blank host app should install `@handrail/erp-financials`, commit SQL generated
from `POSTGRES_CANONICAL_SCHEMA_MANIFEST` and `renderPostgresSchemaSql`, validate
the installed database with `createPostgresStorageAdapter(...).validateSchema()`,
load `ERP_FINANCIALS_STATEMENT_FIXTURE`, and smoke-test the exported report
builders before enabling scheduled rollup, snapshot, late-arrival, and
freshness jobs. See [host-app-install.md](host-app-install.md) for the complete
operator path, [storage-host-app-handoff.md](storage-host-app-handoff.md) for
the worker handoff contract, [operations-runbook.md](operations-runbook.md) for
safe retry and evidence handling, and the future `erp_financials` capability
validation checklist.

For the Handrail QuickBooks SDK/service path, Future ERP should call the
service for provider access and pass normalized resources into the ERP
Financials adapter contract:
`HandrailQuickBooksSdkResourcesAdapterInput` with
`mapHandrailQuickBooksSdkResourcesToCanonicalFacts`. QuickBooks OAuth/token
custody remains inside the integration service. The deterministic handoff smoke
command is:

```sh
npm run contract:smoke
```

The reusable install/schema/fixture/freshness/drilldown health contract command
is:

```sh
npm run health:smoke
```
