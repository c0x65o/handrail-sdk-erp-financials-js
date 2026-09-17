# Transfer reversal verification — 2026-09-17

Base checkout: `24a6bb6edffcd2e0f677a22a7f1e241a59cde3a4`, package `0.3.54`.
The workspace was clean before editing. These source changes are uncommitted;
no version, lockfile, migration or schema checksum was changed. Native finalization
owns version/commit/push and must supply the published full commit before adoption.
See the [public contract and consumer handoff](transfer-reversal-contract.md).

## Changed-file attribution

| File | Change |
| --- | --- |
| `src/erp-financials-service.ts` | Adds transfer input/result/approval types, approval checksum and `transfers.reverse`; reuses deposit's canonical atomic cash-movement reversal path while preserving deposit keys and persisted payloads. Adds transfer approval validation, snapshot and durable replay comparison. |
| `src/index.ts`, `src/sdk.ts` | Exports the new types and approval checksum from both public entry points. The existing SDK commands façade exposes transfer reversal. |
| `test/postgres.integration.test.ts` | Adds 38 real PostgreSQL transfer cases alongside the unchanged 24 deposit cases, reusing scope, snapshot and fiscal-close helpers. |
| `docs/transfer-reversal-contract.md` | Public identity, trusted-host approval, scope, accounting, replay, fiscal and consumer integration contracts. |
| `docs/README.md`, this file | Contract discovery and retained verification evidence. |

## Persistence and concurrency evidence

Used PostgreSQL **15.19** in a disposable worker-local cluster under the worker's
temporary directory, bound only to `127.0.0.1:55439`, database
`erp_financials_test_transfer`. The existing environment-driven integration
harness validates the database name, drops only its isolated test schema between
cases and runs actual ordered SDK migrations. There were no live providers or
shared financial data operations. Configuration: 32 MB shared buffers, 12 maximum
connections; pool maximum 6; one Vitest worker.

The 38 transfer cases cover:

- Public SDK façade success, distinct actual accrual/cash reversal IDs, balanced
  opposite postings, canonical original/reversal links and persisted approval.
- Preservation of every original table row, including transaction source type,
  source payload, identity, operation attribution, document version and book.
- Missing/self approval and initial checksum/command/scope tampering without writes.
- Tenant/company/source/book/currency denial (including valid alternate bindings),
  named-book success and preservation of stored bases despite a changed default.
- Generic journal source restrictions and rejection of non-transfer documents.
- Closed/missing periods and posting locks despite `legacy_unrestricted` settings.
- Identical durable replay after service/pool recreation and fiscal closure,
  with unchanged IDs, zero financial write counts and identical database snapshots.
- Conflicting date, memo, actor, approver, request, reason, transfer, correlation,
  timestamp, reason detail and approval-reference replay, with atomic rejection.
- Late failure from a real SQL trigger on the final document outbox insert:
  both journals, postings, links, events, import batches and snapshot invalidation
  roll back. All table snapshots match, and the same request succeeds after the
  injected trigger is removed.
- Four overlap scenarios: identical requests, conflicting commands under the same
  key, competing keys for the same original, and different transfers sharing a
  key. Each uses distinct `pg_backend_pid()` values and observes the second
  backend in `pg_stat_activity` waiting on an advisory lock before releasing the
  first transaction. Assertions prove one committed reversal and either stable
  replay IDs or the appropriate conflict, with no extra links/postings.

This is independent-connection PostgreSQL evidence, not serialized PGlite proof.
The first focused iteration found one timestamp-conflict error classification
issue (59 passed, 1 failed); an early durable approval comparison corrected it.
Two additional concurrency scenarios were then added. Final focused results below
have no failed transfer or deposit cases. All approval records in these tests are
trusted host fixtures; production hosts must authenticate and authorize approval
as documented, since the checksum is not an authentication mechanism.

## Exact checks

```sh
ERP_FINANCIALS_TEST_DATABASE_URL=postgres://handrail@127.0.0.1:55439/erp_financials_test_transfer npx vitest run test/postgres.integration.test.ts -t 'deposit reversal|transfer reversal' --maxWorkers=1 --no-file-parallelism
```

**62 passed** (38 transfer + 24 deposit), 41 unrelated cases filtered out;
40.88 seconds. No focused case was skipped. Broader unrelated integration cases
were not rerun for this task.

```sh
npx vitest run test/erp-financials-service.test.ts test/financial-lifecycle.test.ts test/fiscal-periods.test.ts test/postgres-migrations.test.ts test/canonical-schema-manifest.test.ts --maxWorkers=1 --no-file-parallelism
```

**71 passed across 5 files**, 3.44 seconds.

```sh
npx eslint src/erp-financials-service.ts src/index.ts src/sdk.ts test/postgres.integration.test.ts --max-warnings=0
npm run build
git diff --check
```

All passed. Build compiles typed source and generates the public declarations;
there are no scoped lint or source compile errors.

```sh
npm run typecheck
```

Full typecheck: **23 pre-existing diagnostics in 13 test files**. For attribution,
`git archive HEAD` was extracted into an isolated temporary baseline directory,
using a symlink to the already-installed toolchain. Running the same typecheck
there produced **the same 23 diagnostics**, with identical messages after
normalizing shifted line numbers. No new diagnostic remains. The affected
baseline tests are `erp-financials-service`, `fiscal-periods`,
`future-erp-canonical-import-smoke`, `general-ledger-contract`,
`normalized-quickbooks-contract-compatibility`, `postgres-storage`,
`postgres.integration`, `quickbooks-dual-basis-backfill`,
`quickbooks-provider-report-parity`, `report-controls`,
`sdk-account-hierarchy-read-model`, `source-adapters`, and
`source-record-dispositions`. Those unrelated failures were left unchanged.

Checks ran sequentially with bounded workers. Recorded check memory peaks were
below 500 MiB with no swap or OOM kills. Handrail MCP context tools were not
available; repository inspection supplied current project/revision evidence.
The disposable PostgreSQL cluster was stopped after validation.

## Remaining work

No SDK implementation blocker remains. Full-typecheck baseline repairs are
separate work. Checklist item `f88a8739-b924-4e6b-9302-a6b37cf1592c` remains open:
it must inspect the native-finalized published candidate, adopt its authorized
public HTTPS full-commit dependency pin and matching ERP lockfile, preserve the
existing deposit adoption and sibling changes, and add installed-SDK transfer
consumer coverage. FinanceService integration stays with dependent item
`d3d9c08f-7649-4d4b-96fa-cffda89c40b6`. No PR, commit, push, deployment, queue or
Handrail database mutation was performed.
