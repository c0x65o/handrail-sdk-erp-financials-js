# Inactive mapped accounts — verification, 2026-09-15

## Scope and revision

Work request: `27bcc926-fb17-4d57-a256-d0a73aac45e5`.
Owner goal: `ab2bc033-4f8e-4f70-8990-540d10633a65`.
Owner task: `5c292ee2-4160-40be-8e05-476a5c66cfd9`.
Prerequisite item: `69d2cb1d-7c19-4121-a91d-18676ce038c1`.

The starting checkout was clean, package version 0.3.52, at
`74b91bacca30b85ed103b708b0cda15cf3fc8a2e`, with origin
`https://github.com/c0x65o/handrail-sdk-erp-financials-js.git`, in the supplied
registered SDK workspace. No applicable `AGENTS.md` was found in the checkout or
its ancestors. The supplied work request and DB-testing KB governed the work.
The Handrail context tool was absent from initial discovery; a later discovery
exposed it, and it confirmed Handrail / ERP Financials SDK project
`94dc753b-f2ee-40e9-8cb7-8c3bd02b86ec` and this work request. The repository-list
reader returned the parent Hitcents scope, so it was not used to redirect work.

Changes remain uncommitted. Package version, lockfile, commits, push, deployment,
consumer repositories, runtime configuration, and queue/goal state were not
modified. The starting SHA is **not** the revision containing this patch.
Handrail's authorized finalization must produce the resulting full commit SHA;
no consumable resulting revision is available during this work phase.

## Public contract and migration ordering

See [the lifecycle and adoption contract](general-ledger-contract.md#inactive-mapped-accounts-schema-version-25).
The existing exported `DefineReportingBookAccountInput` / `ReportingBookService`
API supports inactive creation and both transitions with `active` and
`expectedVersion`. `mapAccount` retains mappings to inactive posting accounts.
New native postings check source and scoped mapped-book account eligibility,
including cash-basis application/refund projections. Identical already-posted
replays remain allowed. Posting holds the account lifecycle locks until commit.

Fresh installs run the immutable ordered migration registry through v25.
Upgrades run remaining migrations through v24, then
`20260915010000_allow_inactive_mapped_accounts.sql` (v24 → v25). Existing SQL
migration files were not edited. The upgrade replaces two trigger functions,
retaining hierarchy, classification, version, identity, and scope constraints.
It neither rewrites accounts/mappings nor modifies posted history.

## Reproduction and database evidence

Used the repository's real `pg` integration harness, with disposable PostgreSQL
15.19 databases and the actual SDK migrations. No SQLite, persistence fake,
provider credential, shared database, browser, or permanent service was used.
Before the fix, the new cases reproduced the mapped-account deactivation trigger
failure and inactive-target mapping rejection. The upgrade case also proved the
old trigger remains in effect before v25.

Five new cases now pass:

- Fresh installation, v16 upgrade, and v24 upgrade: stable account/mapping/source
  identities; deactivation/reactivation; retained profit and loss, balance sheet,
  trial balance, ledger, summary, transactions and postings; inactive balances in
  the chart; denied new postings; restored eligibility; current-operation replay,
  conflicting request input, stale versions and delayed old retries.
- Each upgrade exercises transactional migration failure, unchanged migration
  history/old enforcement after rollback, successful upgrade, and migration replay.
- A real competing PostgreSQL transaction cannot post while deactivation is
  uncommitted (bounded lock timeout); after commit new posting is rejected.
- Inactive source/account creation and mapping in one host transaction; repeated
  calls; mismatched classification and injected failure roll back source,
  account, mapping, lifecycle and outbox writes. Header and tenant/company/book/
  source isolation checks remain enforced, including direct trigger checks.
- Cash-basis application and linked refund creation fail while the revenue book
  account is inactive and roll back documents, applications, journals, postings,
  import batches, audit and outbox. Reactivation permits application; existing
  application/refund replay succeeds while inactive without adding postings.

## Commands and results

All tests used `--maxWorkers=1`. Expensive checks ran sequentially.
The disposable database wrapper ran `initdb -A trust --no-locale`, then
`pg_ctl` with loopback port 55439, `shared_buffers=32MB`, `max_connections=12`,
a private Unix socket directory, and an EXIT trap for `pg_ctl stop -m fast`.
It created `erp_financials_test_inactive` and set
`ERP_FINANCIALS_TEST_DATABASE_URL=postgres://handrail@127.0.0.1:55439/erp_financials_test_inactive`.
An initial separate-command server launch was cleaned up by the worker, causing
`ECONNREFUSED 127.0.0.1:55439`; running database startup, tests and teardown in the
same command resolved that launch issue.

```sh
npm test -- --maxWorkers=1 test/postgres.integration.test.ts \
  -t 'retains inactive|creates inactive|blocks new cash'
```

Result: **5 passed**, 36 unrelated cases deselected. A separate focused run of
fresh migration, v6 upgrade, migration rollback, scoped constraints and historical
book reads also passed (10 cases including the four initial lifecycle cases).

```sh
npm test -- --maxWorkers=1 \
  test/postgres.integration.test.ts \
  test/general-ledger-contract.test.ts \
  test/postgres-migrations.test.ts \
  test/canonical-schema-manifest.test.ts \
  test/sdk-foundation.test.ts \
  test/sdk-account-hierarchy-read-model.test.ts \
  test/erp-financials-service.test.ts \
  test/financial-lifecycle.test.ts \
  test/account-hierarchy-persistence.test.ts \
  test/package-boundary.test.ts \
  test/accounting-basis-projection.test.ts
```

Final result: **138 passed, 11 unrelated integration failures**; all 10 unit-test
files passed (108 tests), and PostgreSQL passed 30/41 cases. An untouched
`git archive HEAD` copy of the starting revision reproduced all 11 failures.
That baseline also failed its obsolete hardcoded schema-version assertion, which
this change updates to the manifest version.

```sh
npm run build
npx eslint src/erp-financials-service.ts src/postgres-migrations.ts \
  src/reporting-books.ts src/schema-manifest.ts src/sdk-read-models.ts \
  test/postgres.integration.test.ts test/postgres-migrations.test.ts \
  test/canonical-schema-manifest.test.ts \
  test/sdk-account-hierarchy-read-model.test.ts --max-warnings=0
git diff --check
```

All passed. `npm run build` compiles every typed source and emits declarations.
A temporary consumer fixture passed
`npx tsc --noEmit --strict --exactOptionalPropertyTypes --skipLibCheck --module nodenext --moduleResolution nodenext <fixture.mts>`:
it imports `DefineReportingBookAccountInput` and `ReportingBookService` from
both built entry points, creates with `active: false`, reactivates with the
returned version, and calls `mapAccount` using `MapReportingBookAccountInput`.
A `node --input-type=module` check imported both
`@handrail/erp-financials` and `@handrail/erp-financials/sdk`, constructed the SDK,
checked its public account methods, loaded migration assets, and verified v25.
No packaging/publication step was run.

`npm run typecheck` reported **23 diagnostics identical to the untouched
baseline**, all in existing tests. A narrower integration-test compile also
found four existing errors at lines 389, 714, 732 and 858; no new lifecycle test
or source diagnostics were reported. `npm run lint` exposed existing errors in
QuickBooks adapter/commercial files and unrelated tests; new test lint findings
were fixed and the final changed-file lint command above passed.

The 11 baseline integration failures concern: QuickBooks open amounts;
three missing-authoritative-open-amount projection fixtures; document retirement
amount constraints; an existing duplicate migration-version probe; customer
statement terminal-transition fixtures; write-off money formatting; bill-payment
void replay money formatting; date-sensitive overdue status; and missing fiscal
period setup in the host-facing workflow test. These remain separate follow-up
work, not blockers for this lifecycle change.

## Exact changed files

- `src/reporting-books.ts`
- `src/erp-financials-service.ts`
- `src/sdk-read-models.ts`
- `src/postgres-migrations.ts`
- `src/schema-manifest.ts`
- `migrations/future-erp/20260915010000_allow_inactive_mapped_accounts.sql`
- `test/postgres.integration.test.ts`
- `test/postgres-migrations.test.ts`
- `test/canonical-schema-manifest.test.ts`
- `test/sdk-account-hierarchy-read-model.test.ts`
- `docs/general-ledger-contract.md`
- `docs/inactive-mapped-accounts-verification.md`

## Downstream continuation

After Handrail finalization, the existing owner task must independently inspect
the settled SDK result, resolve authorization for the exact full-SHA dependency
update in Hitcents project `0f617308-8c3a-4ad4-83e7-34b1fda024b3`, repository
`cb0f9129-828c-4261-8d7a-18a01de0ca8d`, and only then update both dependency files
using public HTTPS and the matching lockfile. Run SDK migrations before adopting
the inactive lifecycle. Resume item `7e4922fd-8494-4c6a-94a4-4af502aa6887` for
mirror integration and direct/Cents/HTTP acceptance. Its dependency-update
restriction remains unchanged. This report is prerequisite evidence, not a claim
that the consumer pin or application acceptance has been completed.
