# Deposit reversal verification — 2026-09-17

Candidate base: `23095ee7d8e225c5336996ca62378c8a3977c0a3`, package v0.3.53.
The checkout was clean before this work. All changes below are uncommitted;
version, lockfile, migrations and migration checksums are unchanged. There is no
approved published SHA for this candidate. See the
[consumer contract and ERP adoption handoff](deposit-reversal-contract.md).

## Changed-file attribution

| File | Change |
| --- | --- |
| `src/erp-financials-service.ts` | Exported deposit reversal types, `deposits.reverse`, narrow internal lifecycle routing, original scope/book checks, both persisted bases, atomic audit/outbox/linking, fiscal and concurrency locks. |
| `src/index.ts`, `src/sdk.ts` | Public input/result type exports. |
| `test/postgres.integration.test.ts` | 24 PostgreSQL cases and small fixture/snapshot helpers using real SDK migrations, transactions and persistence. |
| `docs/deposit-reversal-contract.md` | Consumer usage, guarantees, limits, migration compatibility and downstream handoff. |
| `docs/README.md`, this file | Contract discovery and retained verification evidence. |

Candidate implementation/test diff fingerprint, produced by:

```sh
git diff --binary -- src/erp-financials-service.ts src/index.ts src/sdk.ts test/postgres.integration.test.ts | sha256sum
```

Output: `2cd7dee0cc97e4a350a4f21a7fcc1959430f5308a0f292cccbb93eaa04fd9dea`.
This is a **diff SHA-256**, not a Git revision or publication receipt.

## Harness and coverage

PostgreSQL 15.19 on a disposable worker-local cluster, database
`erp_financials_test_deposit`, listening only on `127.0.0.1:55439`. No shared or
operator database was used. The existing `ERP_FINANCIALS_TEST_DATABASE_URL`
harness validates the test database name, drops only its test schema between
cases, and applies the actual ordered SDK migrations. Tests used one Vitest
worker; concurrency cases used distinct PostgreSQL connections (pool max 6).

The new cases prove:

- Balanced opposite postings in both accrual and cash bases, canonical links,
  document reversal audit and preservation of every original persisted row.
- Missing/self approval rejection and tenant/company/source/book/currency denial.
  Company/source denials include valid alternate bindings. Named-book success
  retains the original book even when the caller's default basis changes.
- Generic journal routing remains restricted; transfer documents are rejected.
- Closed/missing fiscal periods and posting lock dates reject new reversals,
  including legacy-unrestricted callers.
- Exact retry after creating a new pool/service and closing the period returns
  unchanged persistent IDs with zero writes. Date, memo, actor, approver, request,
  reason and deposit changes conflict atomically.
- Two independent PostgreSQL backends overlap in each concurrency test.
  `pg_stat_activity.wait_event = 'advisory'` proves the second backend waits on
  the first transaction before release. Same-key callers produce one reversal
  and one replay; different keys produce one reversal and one terminal conflict.
- A real PostgreSQL trigger fails the final document outbox insert after journal
  work. A snapshot of every table is identical after rollback, covering both
  bases, original facts, import batches, links, lifecycle/outbox rows and report
  invalidation. Removing the injected trigger allows the same command to succeed.

There is no lightweight-dialect or concurrent-transaction harness gap. Old
records lacking original posting provenance are deliberately unsupported and
fail closed, as described in the contract.

## Exact checks and results

Commands ran from the repository root unless noted. Test output was captured in
the worker's temporary directory; the results below are retained here.

```sh
ERP_FINANCIALS_TEST_DATABASE_URL=postgres://handrail@127.0.0.1:55439/erp_financials_test_deposit npx vitest run test/postgres.integration.test.ts -t 'deposit reversal' --maxWorkers=1 --no-file-parallelism
```

Final result: **24 passed, 41 unrelated cases filtered out**, 15.86 seconds.
An earlier iteration had three fixture setup failures; these were corrected by
using the public fiscal-period APIs. The final run has no failures or skipped
deposit cases.

```sh
npx vitest run test/erp-financials-service.test.ts test/financial-lifecycle.test.ts test/postgres-migrations.test.ts test/canonical-schema-manifest.test.ts --maxWorkers=1 --no-file-parallelism
npx eslint src/erp-financials-service.ts src/index.ts src/sdk.ts test/postgres.integration.test.ts --max-warnings=0
npm run build
git diff --check
```

Results: **66 tests passed across four files** (2.94 seconds); scoped lint,
source TypeScript compilation/declaration generation, and whitespace checks
passed. Migrations and canonical schema remain v25 without a new migration.

```sh
ERP_FINANCIALS_TEST_DATABASE_URL=postgres://handrail@127.0.0.1:55439/erp_financials_test_deposit npx vitest run test/postgres.integration.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Broader results: **54 passed, 11 failed** in the integration file; full typecheck
has **23 errors in 13 existing test files**. To establish attribution, the exact
base checkout was extracted with `git archive HEAD` into the worker temporary
directory, sharing only the installed test toolchain via a `node_modules`
symlink. Both commands were rerun from that pristine copy against the same
disposable database. Baseline results: **30 passed, the same 11 failed**; **the
same 23 type errors**, with identical diagnostics after normalizing shifted line
numbers. No new type errors remain, including in the added integration cases.

The pre-existing integration failures are:

1. Imports/replays QuickBooks documents, lines and applications: amount assertion.
2. Preserves every QuickBooks operational document family: projection error.
3. Zero-cash BillPayment vendor-credit application: projection error.
4. Zero-cash Payment credit application: projection error.
5. Retires deleted/missing documents: subledger amount constraint.
6. Existing advisory-lock/repeatable-read test: duplicate migration version.
7. Historical customer statements: application terminal-transition constraint.
8. Invoice write-off settlement: amount assertion.
9. Canonical bill-payment void: stored `open_amount` scale validation.
10. Ordered bill-payment compensation: open-amount assertion.
11. Host-facing end-to-end SDK flow: missing fiscal period.

The deposit-specific concurrency tests passed independently of the failing
pre-existing migration/concurrency test. These unrelated baseline failures were
left unchanged.

The cluster was initialized with `/usr/lib/postgresql/15/bin/initdb -A trust
--no-locale` under the worker temporary directory, with 32 MB shared buffers and
12 maximum connections. An initial background `pg_ctl start` was cleaned up by
the worker after command completion (the next `createdb` returned connection
refused); a foreground `postgres` exec session supplied the final harness.
After validation that session was stopped; `pg_isready -h 127.0.0.1 -p 55439`
reported no response. Recorded check memory peaks were below 500 MiB with zero
swap/OOM kills. Handrail MCP context tools were unavailable, so checkout and
repository inspection supplied scope evidence.

## Remaining work

No SDK implementation blocker remains. Broader baseline checks need separate
repair. Native finalization must supply the approved full Git SHA; then the ERP
owner item still needs its separately scoped Git dependency adoption and canonical
success-case verification. No ERP dependency was changed here, and no commit,
push, deployment, registry publication or live provider operation was performed.
