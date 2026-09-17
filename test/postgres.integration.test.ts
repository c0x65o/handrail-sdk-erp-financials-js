import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  POSTGRES_CANONICAL_SCHEMA_MANIFEST,
  createErpFinancials,
  createTransferReversalApprovalChecksum,
  createErpFinancialsSdk,
  createFiscalCloseEvidenceChecksum,
  migratePostgresSchema,
  persistQuickBooksSubledgerResources,
  resetSourceImportState,
  validatePostgresMigrationHistory,
  validatePostgresSchema
} from "../src/index.js";

import type {
  CanonicalAccountingFactSet,
  CreateVendorBillInput,
  CreateErpFinancialsInput,
  ReverseDepositInput,
  ReverseTransferInput,
  HandrailQuickBooksSdkResourceSet,
  PostgresMigrationTransactionRunner,
  PostgresQueryClient,
  PostgresQueryResult
} from "../src/index.js";
import type { PoolClient, QueryResultRow } from "pg";

const databaseUrl = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
const runIntegration = databaseUrl !== undefined;
const describeIntegration = runIntegration ? describe.sequential : describe.skip;

describeIntegration("ERP Financials real PostgreSQL", () => {
  const safeDatabaseUrl = requiredSafeTestDatabaseUrl(databaseUrl);
  const pool = new Pool({ connectionString: safeDatabaseUrl, max: 6 });
  const runner = new PgTransactionRunner(pool);

  beforeEach(async () => {
    await pool.query('drop schema if exists "erp_financials" cascade');
  });

  afterAll(async () => {
    await pool.query('drop schema if exists "erp_financials" cascade');
    await pool.end();
  });

  async function depositFixture(bookId?: string) {
    await migratePostgresSchema(runner, { appliedByRef: "integration:deposit-reversal" });
    await seedAccountingScope(pool);
    const scope = bookId === undefined ? {} : { bookId };
    if (bookId !== undefined) {
      const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_1", companyId: "company_1",
        bookId, writeSourceId: "source_1", currencyCode: "USD", now: () => "2026-08-12T12:00:00.000Z" });
      await sdk.books.define({ operation: sdkOperation(), bookId, name: "Deposit book", baseCurrencyCode: "USD" });
      await sdk.books.bindSource({ operation: sdkOperation(), bookId, sourceId: "source_1",
        sourceRole: "active", effectiveFrom: "2026-01-01" });
    }
    const financials = depositService(runner, scope);
    await financials.fiscalPeriods.define({
      operation: sdkOperation(), fiscalYear: 2026, periodNumber: 8,
      periodStart: "2026-08-01", periodEnd: "2026-08-31"
    });
    const deposit = await financials.deposits.record({
      operation: { ...sdkOperation(), actorRef: "user:original-recorder", requestId: "request:deposit" },
      idempotencyKey: "deposit:one", date: "2026-08-10", documentNumber: "DEP-1", memo: "Original deposit",
      amount: "123.45", bankAccount: { accountId: "account_cash" }, clearingAccount: { accountId: "account_ar" }
    });
    const input: ReverseDepositInput = {
      depositId: deposit.documentId, idempotencyKey: "reverse:one", date: "2026-08-12",
      memo: "Approved deposit reversal", operation: sdkOperation()
    };
    return { financials, deposit, input };
  }

  it("deposit reversal preserves original identity and attribution, reverses both bases, and links canonical evidence", async () => {
    const { financials, deposit, input } = await depositFixture();
    const before = await depositDatabaseState(pool);
    const result = await financials.deposits.reverse(input);
    expect(result).toMatchObject({ status: "reversed", originalDepositId: deposit.documentId,
      originalTransactionId: deposit.journal.transactionId, reversal: { status: "posted" }, cashReversal: { status: "posted" } });
    expect(result.journalEntryLinkIds).toHaveLength(2);
    const after = await depositDatabaseState(pool);
    // Every original row, including document, transactions, lines, postings,
    // lifecycle actor/request/correlation and outbox book attribution is intact.
    for (const [table, rows] of Object.entries(before)) {
      expect(after[table], table).toEqual(expect.arrayContaining(rows));
    }
    const balances = await pool.query(`select account_id, accounting_basis, currency_code,
      sum(debit_amount) as debit, sum(credit_amount) as credit, sum(net_amount) as net
      from erp_financials.ledger_postings group by account_id, accounting_basis, currency_code`);
    expect(balances.rows).toHaveLength(4);
    for (const row of balances.rows) {
      expect(row).toMatchObject({ currency_code: "USD", debit: "123.45", credit: "123.45", net: "0.00" });
    }
    const links = await pool.query<{ related_transaction_id: string }>(`select link.*, event.actor_ref, event.approver_ref, event.prior_event_id
      from erp_financials.journal_entry_links link join erp_financials.financial_lifecycle_events event
      on event.event_id = link.lifecycle_event_id order by link.original_transaction_id`);
    expect(links.rows).toHaveLength(2);
    for (const row of links.rows) expect(row).toMatchObject({ link_type: "reversal",
      actor_ref: input.operation.actorRef, approver_ref: input.operation.approverRef,
      prior_event_id: deposit.journal.lifecycleEventId });
    expect(links.rows.map((row) => row.related_transaction_id).sort()).toEqual(
      [result.reversal.transactionId, result.cashReversal?.transactionId].sort());
    const documentEvent = await pool.query(`select * from erp_financials.financial_lifecycle_events
      where aggregate_id = $1 and event_type = 'subledger.deposit.reversed'`, [deposit.documentId]);
    expect(documentEvent.rows).toHaveLength(1);
    expect(documentEvent.rows[0]).toMatchObject({ prior_event_id: deposit.journal.lifecycleEventId,
      request_id: input.operation.requestId, correlation_id: input.operation.correlationId });
  });

  it.each(["missing", "self"])("deposit reversal denies %s approval without writes", async (approval) => {
    const { financials, input } = await depositFixture();
    const before = await depositDatabaseState(pool);
    const operation = { ...input.operation };
    delete operation.approverRef;
    await expect(financials.deposits.reverse({ ...input, operation: approval === "self"
      ? { ...operation, approverRef: operation.actorRef } : operation
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("deposit reversal retains a configured book and stored bases despite the caller's default basis", async () => {
    const { input } = await depositFixture("book_deposit");
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner).deposits.reverse(input)).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(await depositDatabaseState(pool)).toEqual(before);
    const reversed = await depositService(runner, { bookId: "book_deposit", accountingBasis: "cash" }).deposits.reverse(input);
    expect(reversed.cashReversal).toBeDefined();
    const outbox = await pool.query<{ book_id: string }>("select book_id from erp_financials.financial_outbox where event_type in ('ledger.posted', 'subledger.deposit.reversed')");
    expect(outbox.rows).toHaveLength(5);
    expect(outbox.rows.every((row) => row.book_id === "book_deposit")).toBe(true);
  });

  it.each([
    { tenantId: "other_tenant" }, { companyId: "other_company" },
    { sourceId: "source_2" }, { bookId: "other_book" }, { currencyCode: "EUR" }
  ])("deposit reversal denies changed scope %j without writes", async (scope) => {
    const { input } = await depositFixture();
    // Bind another company to the same source, and another source to the same
    // company, so denial must include document ownership, not just a missing FK.
    await pool.query(`insert into erp_financials.accounting_companies values
      ('other_company', 'tenant_1', 'Other', 'Other', 'USD', 1, 'test', 'native_erp', 'other');
      insert into erp_financials.company_sources values
      ('other_binding', 'tenant_1', 'other_company', 'source_1', now()),
      ('source_2_binding', 'tenant_1', 'company_1', 'source_2', now())`);
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner, scope).deposits.reverse(input)).rejects.toThrow();
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("deposit reversal rejects generic journal routing and non-deposit documents", async () => {
    const { financials, deposit, input } = await depositFixture();
    await expect(financials.journalEntries.reverse({ ...input,
      originalTransactionId: deposit.journal.transactionId })).rejects.toThrow("not an allowed lifecycle journal");
    const transfer = await financials.transfers.record({ operation: sdkOperation(), idempotencyKey: "transfer:one",
      date: "2026-08-10", amount: "10.00", fromAccount: { accountId: "account_cash" }, toAccount: { accountId: "account_ar" } });
    const before = await depositDatabaseState(pool);
    await expect(financials.deposits.reverse({ ...input, depositId: transfer.documentId })).rejects.toMatchObject({ code: "missing_document" });
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it.each(["closed", "missing", "lock"])("deposit reversal enforces %s fiscal periods even for legacy callers", async (scenario) => {
    const { financials, input } = await depositFixture();
    if (scenario === "closed") await closeDepositPeriod(pool, financials);
    if (scenario === "lock") await financials.fiscalPeriods.setPostingLockDate({
      operation: sdkOperation(), postingLockDate: "2026-08-31", expectedVersion: 0
    });
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner, { postingPolicy: "legacy_unrestricted" }).deposits.reverse({
      ...input, date: scenario === "missing" ? "2026-09-01" : input.date
    })).rejects.toThrow();
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("deposit reversal replays after pool/service recreation and period closure with identical persistent IDs", async () => {
    const { financials, input } = await depositFixture();
    const first = await financials.deposits.reverse(input);
    await closeDepositPeriod(pool, financials);
    const before = await depositDatabaseState(pool);
    const recreatedPool = new Pool({ connectionString: safeDatabaseUrl, max: 2 });
    try {
      const replay = await depositService(new PgTransactionRunner(recreatedPool)).deposits.reverse(input);
      expect(replay).toMatchObject({ ...first, status: "already_reversed",
        reversal: { ...first.reversal, status: "already_posted", snapshotsMarkedStale: 0,
          writeCounts: { importBatches: 0, transactions: 0, transactionLines: 0, postings: 0 } },
        cashReversal: { ...first.cashReversal, status: "already_posted", snapshotsMarkedStale: 0,
          writeCounts: { importBatches: 0, transactions: 0, transactionLines: 0, postings: 0 } } });
      expect(await depositDatabaseState(pool)).toEqual(before);
    } finally { await recreatedPool.end(); }
  });

  it.each(["date", "memo", "actor", "approver", "request", "reason", "deposit"])(
    "deposit reversal rejects conflicting %s replay atomically", async (field) => {
      const { financials, input } = await depositFixture();
      const other = await financials.deposits.record({ operation: sdkOperation(), idempotencyKey: "deposit:other",
        date: "2026-08-10", amount: "123.45", bankAccount: { accountId: "account_cash" }, clearingAccount: { accountId: "account_ar" } });
      await financials.deposits.reverse(input);
      const before = await depositDatabaseState(pool);
      const changed = { ...input,
        ...(field === "date" ? { date: "2026-08-13" } : {}),
        ...(field === "memo" ? { memo: "Different" } : {}),
        ...(field === "deposit" ? { depositId: other.documentId } : {}),
        operation: { ...input.operation,
          ...(field === "actor" ? { actorRef: "user:other" } : {}),
          ...(field === "approver" ? { approverRef: "user:other-controller" } : {}),
          ...(field === "request" ? { requestId: "request:other" } : {}),
          ...(field === "reason" ? { reasonCode: "different_reason" } : {}) }
      };
      await expect(financials.deposits.reverse(changed)).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await depositDatabaseState(pool)).toEqual(before);
    }
  );

  it("deposit reversal rolls back postings, links, events, outbox and snapshot invalidation on late SQL failure", async () => {
    const { financials, input } = await depositFixture();
    await pool.query(`insert into erp_financials.report_snapshots (
      report_snapshot_id, tenant_id, company_id, source_id, report_name, snapshot_source,
      accounting_basis, period_start, period_end, as_of_date, currency_code, generated_at,
      freshness, reconciliation_status, reconciliation_difference
    ) values ('deposit_snapshot', 'tenant_1', 'company_1', 'source_1', 'profit_and_loss', 'rollup',
      'accrual', '2026-08-01', '2026-08-31', '2026-08-31', 'USD', now(),
      '{"status":"fresh","sourceId":"source_1"}'::jsonb, 'reconciled', 0);
    create function erp_financials.fail_deposit_outbox() returns trigger language plpgsql as $$
    begin if new.event_type = 'subledger.deposit.reversed' then raise exception 'injected late deposit failure'; end if;
    return new; end $$;
    create trigger fail_deposit_outbox before insert on erp_financials.financial_outbox
      for each row execute function erp_financials.fail_deposit_outbox()`);
    const before = await depositDatabaseState(pool);
    await expect(financials.deposits.reverse(input)).rejects.toThrow("injected late deposit failure");
    expect(await depositDatabaseState(pool)).toEqual(before);
    await pool.query("drop trigger fail_deposit_outbox on erp_financials.financial_outbox");
    await expect(financials.deposits.reverse(input)).resolves.toMatchObject({ status: "reversed" });
  });

  it.each([true, false])("deposit reversal serializes real concurrent transactions (same key: %s)", async (sameKey) => {
    const { input } = await depositFixture();
    let releaseFirst!: () => void;
    let firstHasLock!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const locked = new Promise<void>((resolve) => { firstHasLock = resolve; });
    const backendIds: number[] = [];
    let connectionCount = 0;
    const concurrentRunner: PostgresMigrationTransactionRunner = {
      transaction: (work) => runner.transaction(async (client) => {
        const id = await client.query("select pg_backend_pid() as pid");
        backendIds.push(Number(id.rows[0]?.pid));
        const first = connectionCount++ === 0;
        const observed: PostgresQueryClient = {
          async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
            const result = await client.query<Row>(sql, params);
            if (first && sql.includes("pg_advisory_xact_lock") && String(params?.[0]).startsWith("deposit-reversal:")) {
              firstHasLock();
              await holdFirst;
            }
            return result;
          }
        };
        return work(observed);
      })
    };
    const first = depositService(concurrentRunner).deposits.reverse(input);
    await locked;
    const second = depositService(concurrentRunner).deposits.reverse({ ...input,
      idempotencyKey: sameKey ? input.idempotencyKey : "competing-reversal" });
    // Attach rejection handlers immediately, then prove the second backend is
    // actually blocked on the transaction advisory lock before releasing it.
    const outcomesPromise = Promise.allSettled([first, second]);
    try {
      await expect.poll(async () => {
        if (backendIds.length !== 2) return false;
        const waiting = await pool.query<{ wait_event: string }>("select wait_event from pg_stat_activity where pid = $1", [backendIds[1]]);
        return waiting.rows[0]?.wait_event;
      }).toBe("advisory");
      expect(new Set(backendIds).size).toBe(2);
    } finally { releaseFirst(); }
    const outcomes = await outcomesPromise;
    expect(outcomes[0].status).toBe("fulfilled");
    if (sameKey) {
      expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { status: "already_reversed" } });
    } else {
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") {
        const failure: unknown = outcomes[1].reason;
        expect(failure).toBeInstanceOf(Error);
        if (failure instanceof Error) expect(failure.message).toContain("terminal reversal");
      }
    }
    expect((await pool.query("select * from erp_financials.journal_entry_links")).rows).toHaveLength(2);
    expect((await pool.query("select * from erp_financials.ledger_postings")).rows).toHaveLength(8);
  });

  function approveTransfer(
    command: Omit<ReverseTransferInput, "approval"> & { readonly approval?: ReverseTransferInput["approval"] },
    scope: Partial<CreateErpFinancialsInput> = {}
  ): ReverseTransferInput {
    return { ...command, approval: {
      approvalRef: command.approval?.approvalRef ?? "approval:transfer-one",
      operationChecksum: createTransferReversalApprovalChecksum({
        tenantId: "tenant_1", companyId: "company_1", sourceId: "source_1", currencyCode: "USD", ...scope
      }, command)
    } };
  }

  async function transferFixture(bookId?: string) {
    await migratePostgresSchema(runner, { appliedByRef: "integration:transfer-reversal" });
    await seedAccountingScope(pool);
    const scope = bookId === undefined ? {} : { bookId };
    if (bookId !== undefined) {
      const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_1", companyId: "company_1",
        bookId, writeSourceId: "source_1", currencyCode: "USD", now: () => "2026-08-12T12:00:00.000Z" });
      await sdk.books.define({ operation: sdkOperation(), bookId, name: "Transfer book", baseCurrencyCode: "USD" });
      await sdk.books.bindSource({ operation: sdkOperation(), bookId, sourceId: "source_1",
        sourceRole: "active", effectiveFrom: "2026-01-01" });
    }
    const financials = depositService(runner, scope);
    await financials.fiscalPeriods.define({
      operation: sdkOperation(), fiscalYear: 2026, periodNumber: 8,
      periodStart: "2026-08-01", periodEnd: "2026-08-31"
    });
    const transfer = await financials.transfers.record({
      operation: { ...sdkOperation(), actorRef: "user:original-recorder", requestId: "request:transfer" },
      idempotencyKey: "transfer:one", date: "2026-08-10", documentNumber: "TRF-1", memo: "Original transfer",
      amount: "123.45", toAccount: { accountId: "account_cash" }, fromAccount: { accountId: "account_ar" }
    });
    const command = {
      transferId: transfer.documentId, idempotencyKey: "reverse:one", date: "2026-08-12",
      memo: "Approved transfer reversal", operation: sdkOperation()
    };
    return { financials, transfer, input: approveTransfer(command, scope) };
  }

  it("transfer reversal preserves original identity and attribution, reverses both bases, and links canonical evidence", async () => {
    const { transfer, input } = await transferFixture("book_transfer");
    const before = await depositDatabaseState(pool);
    const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_1", companyId: "company_1",
      bookId: "book_transfer", writeSourceId: "source_1", currencyCode: "USD", now: () => "2026-08-12T12:00:00.000Z" });
    const result = await sdk.commands.transfers.reverse(input);
    expect(result).toMatchObject({ status: "reversed", originalTransferId: transfer.documentId,
      originalTransactionId: transfer.journal.transactionId, reversal: { status: "posted" }, cashReversal: { status: "posted" } });
    expect(result.reversal.transactionId).not.toBe(transfer.journal.transactionId);
    expect(result.cashReversal?.transactionId).not.toBe(result.reversal.transactionId);
    expect(result.journalEntryLinkIds).toHaveLength(2);
    const after = await depositDatabaseState(pool);
    // Every original row, including document, transactions, lines, postings,
    // lifecycle actor/request/correlation and outbox book attribution is intact.
    for (const [table, rows] of Object.entries(before)) {
      expect(after[table], table).toEqual(expect.arrayContaining(rows));
    }
    const balances = await pool.query(`select account_id, accounting_basis, currency_code,
      sum(debit_amount) as debit, sum(credit_amount) as credit, sum(net_amount) as net
      from erp_financials.ledger_postings group by account_id, accounting_basis, currency_code`);
    expect(balances.rows).toHaveLength(4);
    for (const row of balances.rows) {
      expect(row).toMatchObject({ currency_code: "USD", debit: "123.45", credit: "123.45", net: "0.00" });
    }
    const links = await pool.query<{ related_transaction_id: string }>(`select link.*, event.actor_ref, event.approver_ref, event.prior_event_id
      from erp_financials.journal_entry_links link join erp_financials.financial_lifecycle_events event
      on event.event_id = link.lifecycle_event_id order by link.original_transaction_id`);
    expect(links.rows).toHaveLength(2);
    for (const row of links.rows) expect(row).toMatchObject({ link_type: "reversal",
      actor_ref: input.operation.actorRef, approver_ref: input.operation.approverRef,
      prior_event_id: transfer.journal.lifecycleEventId });
    expect(links.rows.map((row) => row.related_transaction_id).sort()).toEqual(
      [result.reversal.transactionId, result.cashReversal?.transactionId].sort());
    const documentEvent = await pool.query(`select * from erp_financials.financial_lifecycle_events
      where aggregate_id = $1 and event_type = 'subledger.transfer.reversed'`, [transfer.documentId]);
    expect(documentEvent.rows).toHaveLength(1);
    expect(documentEvent.rows[0]).toMatchObject({ prior_event_id: transfer.journal.lifecycleEventId,
      request_id: input.operation.requestId, correlation_id: input.operation.correlationId,
      payload: { approval: input.approval } });
  });

  it.each(["missing", "self"])("transfer reversal denies %s approval without writes", async (approval) => {
    const { financials, input } = await transferFixture();
    const before = await depositDatabaseState(pool);
    const operation = { ...input.operation };
    delete operation.approverRef;
    await expect(financials.transfers.reverse({ ...input, operation: approval === "self"
      ? { ...operation, approverRef: operation.actorRef } : operation
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("transfer reversal retains a configured book and stored bases despite the caller's default basis", async () => {
    const { input } = await transferFixture("book_transfer");
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner).transfers.reverse(approveTransfer(input))).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(await depositDatabaseState(pool)).toEqual(before);
    const reversed = await depositService(runner, { bookId: "book_transfer", accountingBasis: "cash" }).transfers.reverse(input);
    expect(reversed.cashReversal).toBeDefined();
    const outbox = await pool.query<{ book_id: string }>("select book_id from erp_financials.financial_outbox where event_type in ('ledger.posted', 'subledger.transfer.reversed')");
    expect(outbox.rows).toHaveLength(5);
    expect(outbox.rows.every((row) => row.book_id === "book_transfer")).toBe(true);
  });

  it.each([
    { tenantId: "other_tenant" }, { companyId: "other_company" },
    { sourceId: "source_2" }, { bookId: "other_book" }, { currencyCode: "EUR" }
  ])("transfer reversal denies changed scope %j without writes", async (scope) => {
    const { input } = await transferFixture();
    // Bind another company to the same source, and another source to the same
    // company, so denial must include document ownership, not just a missing FK.
    await pool.query(`insert into erp_financials.accounting_companies values
      ('other_company', 'tenant_1', 'Other', 'Other', 'USD', 1, 'test', 'native_erp', 'other');
      insert into erp_financials.company_sources values
      ('other_binding', 'tenant_1', 'other_company', 'source_1', now()),
      ('source_2_binding', 'tenant_1', 'company_1', 'source_2', now())`);
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner, scope).transfers.reverse(approveTransfer(input, scope))).rejects.toThrow();
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("transfer reversal rejects generic journal routing and non-transfer documents", async () => {
    const { financials, transfer, input } = await transferFixture();
    await expect(financials.journalEntries.reverse({ ...input,
      originalTransactionId: transfer.journal.transactionId })).rejects.toThrow("not an allowed lifecycle journal");
    const deposit = await financials.deposits.record({ operation: sdkOperation(), idempotencyKey: "deposit:other",
      date: "2026-08-10", amount: "10.00", bankAccount: { accountId: "account_cash" }, clearingAccount: { accountId: "account_ar" } });
    const before = await depositDatabaseState(pool);
    await expect(financials.transfers.reverse(approveTransfer({ ...input, transferId: deposit.documentId }))).rejects.toMatchObject({ code: "missing_document" });
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it.each(["closed", "missing", "lock"])("transfer reversal enforces %s fiscal periods even for legacy callers", async (scenario) => {
    const { financials, input } = await transferFixture();
    if (scenario === "closed") await closeDepositPeriod(pool, financials);
    if (scenario === "lock") await financials.fiscalPeriods.setPostingLockDate({
      operation: sdkOperation(), postingLockDate: "2026-08-31", expectedVersion: 0
    });
    const before = await depositDatabaseState(pool);
    await expect(depositService(runner, { postingPolicy: "legacy_unrestricted" }).transfers.reverse({
      ...approveTransfer({ ...input, date: scenario === "missing" ? "2026-09-01" : input.date })
    })).rejects.toThrow();
    expect(await depositDatabaseState(pool)).toEqual(before);
  });

  it("transfer reversal replays after pool/service recreation and period closure with identical persistent IDs", async () => {
    const { financials, input } = await transferFixture();
    const first = await financials.transfers.reverse(input);
    await closeDepositPeriod(pool, financials);
    const before = await depositDatabaseState(pool);
    const recreatedPool = new Pool({ connectionString: safeDatabaseUrl, max: 2 });
    try {
      const replay = await depositService(new PgTransactionRunner(recreatedPool)).transfers.reverse(input);
      expect(replay).toMatchObject({ ...first, status: "already_reversed",
        reversal: { ...first.reversal, status: "already_posted", snapshotsMarkedStale: 0,
          writeCounts: { importBatches: 0, transactions: 0, transactionLines: 0, postings: 0 } },
        cashReversal: { ...first.cashReversal, status: "already_posted", snapshotsMarkedStale: 0,
          writeCounts: { importBatches: 0, transactions: 0, transactionLines: 0, postings: 0 } } });
      expect(await depositDatabaseState(pool)).toEqual(before);
    } finally { await recreatedPool.end(); }
  });

  it.each(["date", "memo", "actor", "approver", "request", "reason", "transfer", "correlation", "occurredAt", "reasonDetail", "approvalRef"])(
    "transfer reversal rejects conflicting %s replay atomically", async (field) => {
      const { financials, input } = await transferFixture();
      const other = await financials.transfers.record({ operation: sdkOperation(), idempotencyKey: "transfer:other",
        date: "2026-08-10", amount: "123.45", toAccount: { accountId: "account_cash" }, fromAccount: { accountId: "account_ar" } });
      await financials.transfers.reverse(input);
      const before = await depositDatabaseState(pool);
      const changed = { ...input,
        ...(field === "approvalRef" ? { approval: { ...input.approval, approvalRef: "approval:other" } } : {}),
        ...(field === "date" ? { date: "2026-08-13" } : {}),
        ...(field === "memo" ? { memo: "Different" } : {}),
        ...(field === "transfer" ? { transferId: other.documentId } : {}),
        operation: { ...input.operation,
          ...(field === "actor" ? { actorRef: "user:other" } : {}),
          ...(field === "approver" ? { approverRef: "user:other-controller" } : {}),
          ...(field === "request" ? { requestId: "request:other" } : {}),
          ...(field === "reason" ? { reasonCode: "different_reason" } : {}),
          ...(field === "correlation" ? { correlationId: "correlation:other" } : {}),
          ...(field === "occurredAt" ? { occurredAt: "2026-08-12T12:00:01.000Z" } : {}),
          ...(field === "reasonDetail" ? { reasonDetail: "other reason detail" } : {}) }
      };
      await expect(financials.transfers.reverse(approveTransfer(changed))).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await depositDatabaseState(pool)).toEqual(before);
    }
  );

  it("transfer reversal rolls back postings, links, events, outbox and snapshot invalidation on late SQL failure", async () => {
    const { financials, input } = await transferFixture();
    await pool.query(`insert into erp_financials.report_snapshots (
      report_snapshot_id, tenant_id, company_id, source_id, report_name, snapshot_source,
      accounting_basis, period_start, period_end, as_of_date, currency_code, generated_at,
      freshness, reconciliation_status, reconciliation_difference
    ) values ('transfer_snapshot', 'tenant_1', 'company_1', 'source_1', 'profit_and_loss', 'rollup',
      'accrual', '2026-08-01', '2026-08-31', '2026-08-31', 'USD', now(),
      '{"status":"fresh","sourceId":"source_1"}'::jsonb, 'reconciled', 0);
    create function erp_financials.fail_transfer_outbox() returns trigger language plpgsql as $$
    begin if new.event_type = 'subledger.transfer.reversed' then raise exception 'injected late transfer failure'; end if;
    return new; end $$;
    create trigger fail_transfer_outbox before insert on erp_financials.financial_outbox
      for each row execute function erp_financials.fail_transfer_outbox()`);
    const before = await depositDatabaseState(pool);
    await expect(financials.transfers.reverse(input)).rejects.toThrow("injected late transfer failure");
    expect(await depositDatabaseState(pool)).toEqual(before);
    await pool.query("drop trigger fail_transfer_outbox on erp_financials.financial_outbox");
    await expect(financials.transfers.reverse(input)).resolves.toMatchObject({ status: "reversed" });
  });

  it.each(["identical", "conflicting", "competing", "different-transfer"])("transfer reversal serializes real concurrent transactions (%s)", async (scenario) => {
    const { financials, input } = await transferFixture();
    const other = scenario === "different-transfer" ? await financials.transfers.record({
      operation: sdkOperation(), idempotencyKey: "transfer:other", date: "2026-08-10", amount: "123.45",
      toAccount: { accountId: "account_cash" }, fromAccount: { accountId: "account_ar" }
    }) : undefined;
    let releaseFirst!: () => void;
    let firstHasLock!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const locked = new Promise<void>((resolve) => { firstHasLock = resolve; });
    const backendIds: number[] = [];
    let connectionCount = 0;
    const concurrentRunner: PostgresMigrationTransactionRunner = {
      transaction: (work) => runner.transaction(async (client) => {
        const id = await client.query("select pg_backend_pid() as pid");
        backendIds.push(Number(id.rows[0]?.pid));
        const first = connectionCount++ === 0;
        const observed: PostgresQueryClient = {
          async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
            const result = await client.query<Row>(sql, params);
            if (first && sql.includes("pg_advisory_xact_lock") && String(params?.[0]).startsWith("fiscal-period:")) {
              firstHasLock();
              await holdFirst;
            }
            return result;
          }
        };
        return work(observed);
      })
    };
    const first = depositService(concurrentRunner).transfers.reverse(input);
    await locked;
    const second = depositService(concurrentRunner).transfers.reverse(approveTransfer({ ...input,
      idempotencyKey: scenario === "competing" ? "competing-reversal" : input.idempotencyKey,
      ...(scenario === "conflicting" ? { memo: "different approved command" } : {}),
      ...(other === undefined ? {} : { transferId: other.documentId }) }));
    // Attach rejection handlers immediately, then prove the second backend is
    // actually blocked on the transaction advisory lock before releasing it.
    const outcomesPromise = Promise.allSettled([first, second]);
    try {
      await expect.poll(async () => {
        if (backendIds.length !== 2) return false;
        const waiting = await pool.query<{ wait_event: string }>("select wait_event from pg_stat_activity where pid = $1", [backendIds[1]]);
        return waiting.rows[0]?.wait_event;
      }).toBe("advisory");
      expect(new Set(backendIds).size).toBe(2);
    } finally { releaseFirst(); }
    const outcomes = await outcomesPromise;
    expect(outcomes[0].status).toBe("fulfilled");
    if (scenario === "identical") {
      expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: { status: "already_reversed" } });
      if (outcomes[0].status === "fulfilled" && outcomes[1].status === "fulfilled") {
        expect(outcomes[1].value.reversal.transactionId).toBe(outcomes[0].value.reversal.transactionId);
        expect(outcomes[1].value.cashReversal?.transactionId).toBe(outcomes[0].value.cashReversal?.transactionId);
      }
    } else {
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") {
        const failure: unknown = outcomes[1].reason;
        expect(failure).toBeInstanceOf(Error);
        if (scenario === "competing") {
          if (failure instanceof Error) expect(failure.message).toContain("terminal reversal");
        } else {
          expect(failure).toMatchObject({ code: "idempotency_conflict" });
        }
      }
    }
    expect((await pool.query("select * from erp_financials.journal_entry_links")).rows).toHaveLength(2);
    expect((await pool.query("select * from erp_financials.ledger_postings")).rows).toHaveLength(other === undefined ? 8 : 12);
  });

  it.each(["missing", "checksum", "date", "transfer", "memo", "actor", "approver", "scope"])(
    "transfer reversal denies %s tampering before the first write", async (field) => {
      const { financials, input } = await transferFixture();
      const before = await depositDatabaseState(pool);
      const changed = { ...input,
        ...(field === "missing" ? { approval: undefined } : {}),
        ...(field === "checksum" ? { approval: { ...input.approval, operationChecksum: "forged" } } : {}),
        ...(field === "date" ? { date: "2026-08-13" } : {}),
        ...(field === "transfer" ? { transferId: "other-transfer" } : {}),
        ...(field === "memo" ? { memo: "unapproved" } : {}),
        operation: { ...input.operation,
          ...(field === "actor" ? { actorRef: "user:other" } : {}),
          ...(field === "approver" ? { approverRef: "user:other-controller" } : {}) }
      };
      const service = field === "scope" ? depositService(runner, { bookId: "other" }) : financials;
      await expect(service.transfers.reverse(changed as ReverseTransferInput)).rejects.toMatchObject({ code: "authorization_context_invalid" });
      expect(await depositDatabaseState(pool)).toEqual(before);
    }
  );

  it("migrates a blank database transactionally and validates schema plus immutable migration history", async () => {
    const result = await migratePostgresSchema(runner, { appliedByRef: "integration:blank-install" });
    const client = new PgQueryClient(pool);
    const schema = await validatePostgresSchema(client);
    const history = await validatePostgresMigrationHistory(client);

    expect(result.targetVersion).toBe(POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion);
    expect(result.applied.at(-1)?.toVersion).toBe(POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion);
    expect(schema).toMatchObject({ compatible: true, fixtureSupport: true, issues: [] });
    expect(history).toMatchObject({ compatible: true, currentVersion: POSTGRES_CANONICAL_SCHEMA_MANIFEST.schemaVersion, issues: [] });
    await expect(
      pool.query("update erp_financials.schema_migrations set name = 'tampered' where to_version = 20")
    ).rejects.toThrow("schema migration history is append-only");
  });

  it("imports and safely replays QuickBooks documents, lines, and applications", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:quickbooks-subledger" });
    await seedQuickBooksImportScope(pool);
    const facts = quickBooksSubledgerFacts();
    const initialResources = quickBooksSubledgerResources("40.00", true, "2026-08-10T10:00:00.000Z");
    const persist = (input: { readonly importedAt: string; readonly resources: HandrailQuickBooksSdkResourceSet }) =>
      runner.transaction((client) => persistQuickBooksSubledgerResources({
        client,
        companyId: "company_qbo",
        facts,
        ...input
      }));

    const first = await persist({
      importedAt: "2026-08-10T10:01:00.000Z",
      resources: initialResources
    });
    expect(first).toMatchObject({ documents: 2, applications: 1, skippedApplications: 0 });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "60.00", status: "partially_applied" },
      { source_id: "payment_700", original_amount: "40.00", open_amount: "0.00", status: "settled" }
    ]);

    const replay = await persist({
      importedAt: "2026-08-10T10:02:00.000Z",
      resources: initialResources
    });
    expect(replay).toMatchObject({ documents: 0, applications: 0, skippedApplications: 0 });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "60.00", status: "partially_applied" },
      { source_id: "payment_700", original_amount: "40.00", open_amount: "0.00", status: "settled" }
    ]);

    const revisedResources = quickBooksSubledgerResources("50.00", true, "2026-08-11T10:00:00.000Z");
    await persist({
      importedAt: "2026-08-11T10:01:00.000Z",
      resources: revisedResources
    });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "50.00", status: "partially_applied" },
      { source_id: "payment_700", original_amount: "50.00", open_amount: "0.00", status: "settled" }
    ]);

    await persist({
      importedAt: "2026-08-12T10:01:00.000Z",
      resources: quickBooksSubledgerResources("50.00", false, "2026-08-12T10:00:00.000Z")
    });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "100.00", status: "open" },
      { source_id: "payment_700", original_amount: "50.00", open_amount: "50.00", status: "open" }
    ]);
  });

  it("completely resets one imported source while preserving identities, configuration, native facts, and another import source", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:source-import-reset" });
    await seedSourceImportResetScenario(pool, runner);

    const counts = await runner.transaction((client) => resetSourceImportState(client, {
      tenantId: "tenant_qbo",
      companyId: "company_qbo",
      sourceId: "source_qbo"
    }));

    expect(counts).toMatchObject({
      reportSnapshotLinesDeleted: 1,
      reportSnapshotTotalsDeleted: 1,
      reportSnapshotsDeleted: 1,
      freshnessRowsDeleted: 1,
      rollupBucketsDeleted: 1,
      subledgerApplicationsDeleted: 1,
      subledgerDocumentLinesDeleted: 1,
      subledgerDocumentsDeleted: 2,
      ledgerPostingsDeleted: 2,
      transactionLinesDeleted: 2,
      transactionsDeleted: 2,
      importBatchesDeleted: 1,
      syncCheckpointsDeleted: 1,
      lifecycleEventsDeleted: 3,
      accountsRetired: 2,
      partiesRetired: 1,
      itemsRetired: 1,
      dimensionsRetired: 1,
      sourceSyncStateCleared: 1,
      countsCapped: false
    });
    const state = await sourceResetState(pool);
    expect(state).toMatchObject({
      selectedRuntimeRows: "0",
      selectedActiveMasterRows: "0",
      selectedIdentityRows: "3",
      reportingConfigurationRows: "4",
      otherSourceRows: "4",
      nativeSourceRows: "4",
      selectedStatus: "pending"
    });

    const replay = await runner.transaction((client) => resetSourceImportState(client, {
      tenantId: "tenant_qbo",
      companyId: "company_qbo",
      sourceId: "source_qbo"
    }));
    expect(Object.entries(replay).filter(([key]) => key !== "countsCapped").every(([, value]) => value === 0)).toBe(true);
    expect(replay.countsCapped).toBe(false);
  });

  it("rolls back every source reset mutation when the surrounding transaction fails", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:source-import-reset-rollback" });
    await seedSourceImportResetScenario(pool, runner);
    const before = await sourceResetState(pool);

    await expect(runner.transaction(async (client) => {
      await resetSourceImportState(client, {
        tenantId: "tenant_qbo",
        companyId: "company_qbo",
        sourceId: "source_qbo"
      });
      throw new Error("injected host failure");
    })).rejects.toThrow("injected host failure");

    await expect(sourceResetState(pool)).resolves.toEqual(before);
  });

  it("preserves every QuickBooks operational document family and application relationship", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:quickbooks-document-families" });
    await seedQuickBooksAllDocumentScope(pool);
    const facts = quickBooksAllDocumentFacts();
    const resources = quickBooksAllDocumentResources();

    const imported = await runner.transaction((client) => persistQuickBooksSubledgerResources({
      client,
      companyId: "company_qbo",
      importedAt: "2026-08-10T10:01:00.000Z",
      facts,
      resources
    }));

    expect(imported).toMatchObject({
      documents: 11,
      documentLines: 9,
      applications: 4,
      skippedTransactions: 0,
      skippedDocumentLines: 0,
      skippedApplications: 0,
      unresolvedApplications: []
    });
    const documents = await pool.query<{
      document_type: string;
      source_transaction_type: string;
    }>(`
select document_type, metadata ->> 'sourceTransactionType' as source_transaction_type
from erp_financials.subledger_documents
where tenant_id = 'tenant_qbo' and source_id = 'source_qbo'
order by document_type
`);
    expect(documents.rows).toEqual([
      { document_type: "bill_payment", source_transaction_type: "BillPayment" },
      { document_type: "credit_memo", source_transaction_type: "CreditMemo" },
      { document_type: "customer_payment", source_transaction_type: "Payment" },
      { document_type: "deposit", source_transaction_type: "Deposit" },
      { document_type: "invoice", source_transaction_type: "Invoice" },
      { document_type: "purchase", source_transaction_type: "Purchase" },
      { document_type: "refund", source_transaction_type: "RefundReceipt" },
      { document_type: "sales_receipt", source_transaction_type: "SalesReceipt" },
      { document_type: "transfer", source_transaction_type: "Transfer" },
      { document_type: "vendor_bill", source_transaction_type: "Bill" },
      { document_type: "vendor_credit", source_transaction_type: "VendorCredit" }
    ]);

    const applications = await pool.query<{ application_type: string }>(`
select application_type
from erp_financials.subledger_applications
where tenant_id = 'tenant_qbo' and source_id = 'source_qbo'
order by application_type
`);
    expect(applications.rows).toEqual([
      { application_type: "bill_payment_to_bill" },
      { application_type: "credit_to_invoice" },
      { application_type: "customer_payment_to_invoice" },
      { application_type: "vendor_credit_to_bill" }
    ]);

    const semantics = await pool.query<{
      invoice_due_date: string;
      bill_due_date: string;
      invoice_party_type: string;
      bill_party_type: string;
      invoice_quantity: string;
      invoice_unit_amount: string;
      invoice_tax_code: string;
    }>(`
select
  max(document.due_date::text) filter (where document.document_type = 'invoice') as invoice_due_date,
  max(document.due_date::text) filter (where document.document_type = 'vendor_bill') as bill_due_date,
  max(party.party_type) filter (where document.document_type = 'invoice') as invoice_party_type,
  max(party.party_type) filter (where document.document_type = 'vendor_bill') as bill_party_type,
  max(line.quantity::text) filter (where document.document_type = 'invoice') as invoice_quantity,
  max(line.unit_amount::text) filter (where document.document_type = 'invoice') as invoice_unit_amount,
  max(line.tax_code) filter (where document.document_type = 'invoice') as invoice_tax_code
from erp_financials.subledger_documents document
left join erp_financials.parties party on party.party_id = document.party_id
left join erp_financials.subledger_document_lines line
  on line.subledger_document_id = document.subledger_document_id
where document.tenant_id = 'tenant_qbo' and document.source_id = 'source_qbo'
`);
    expect(semantics.rows[0]).toEqual({
      invoice_due_date: "2026-08-31",
      bill_due_date: "2026-08-25",
      invoice_party_type: "customer",
      bill_party_type: "vendor",
      invoice_quantity: "2.00",
      invoice_unit_amount: "50.00",
      invoice_tax_code: "TAX"
    });

    const replay = await runner.transaction((client) => persistQuickBooksSubledgerResources({
      client,
      companyId: "company_qbo",
      importedAt: "2026-08-10T10:02:00.000Z",
      facts,
      resources
    }));
    expect(replay).toMatchObject({ documents: 0, applications: 0, skippedApplications: 0 });
  });

  it.each([false, true])("preserves wrapper ownership through credit-only deltas (customer=%s)", async (customer) => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:credit-delta-ownership" });
    const { facts, resources } = await creditOwnershipFixture(pool, customer);
    const persist = (documents = resources.operationalDocuments, full = false) => runner.transaction((client) =>
      persistQuickBooksSubledgerResources({ client, companyId: "company_qbo", facts,
        resources: { ...resources, operationalDocuments: documents ?? [] },
        importedAt: "2026-09-11T10:00:00.000Z", replaceMissingDocuments: full }));
    await persist(resources.operationalDocuments, true);
    const before = await creditOwnershipState(pool);
    expect(before.documents).toEqual([
      { source_id: "2572", original_amount: "1922.58", open_amount: "0.00", status: "settled" },
      { source_id: "2573", original_amount: "1861.52", open_amount: "0.00", status: "settled" }
    ]);
    const delta = resources.operationalDocuments?.filter(row => row.resourceId === "2572");
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await persist(delta)).toMatchObject({ applications: 0, removedLedgerPostings: 0 });
      expect(await creditOwnershipState(pool)).toEqual(before);
    }
    const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_qbo", companyId: "company_qbo",
      bookId: "book_credit", writeSourceId: "source_qbo", currencyCode: "USD", postingPolicy: "legacy_unrestricted" });
    await sdk.books.define({ operation: sdkOperation(), bookId: "book_credit", name: "Credit test", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation: { ...sdkOperation(), requestId: "request:credit-source" },
      bookId: "book_credit", sourceId: "source_qbo", sourceRole: "active", effectiveFrom: "2025-01-01" });
    expect(await sdk.queries.getAging({ kind: customer ? "receivables" : "payables", asOfDate: "2026-09-11" }))
      .toMatchObject({ rows: [], totals: { total: "0.00", daysOver90: "0.00" } });
  });

  it.each([
    [false, "changed"], [false, "voided"], [false, "deleted"], [false, "malformed"],
    [true, "changed"], [true, "voided"], [true, "deleted"], [true, "malformed"]
  ] as const)("still reconciles the owning wrapper (customer=%s, action=%s)", async (customer, action) => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:credit-wrapper-retirement" });
    const { facts, resources } = await creditOwnershipFixture(pool, customer);
    const persist = (documents = resources.operationalDocuments) => runner.transaction((client) =>
      persistQuickBooksSubledgerResources({ client, companyId: "company_qbo", facts,
        resources: { ...resources, operationalDocuments: documents ?? [] }, importedAt: "2026-09-11T11:00:00.000Z" }));
    await persist();
    const wrapper = resources.operationalDocuments?.find(row => row.resourceId === "2574");
    if (!wrapper) throw new Error("Missing wrapper fixture");
    const delta = [{ ...wrapper,
      ...(action === "voided" || action === "deleted" ? { syncAction: action } : {}),
      resource: { ...wrapper.resource, sourceUpdatedAt: "2026-09-11T11:00:00.000Z",
        lines: action === "malformed" ? [] : wrapper.resource.lines.map(line => ({ ...line, sourceAmount: "1800.00" })) }
    }];
    if (action === "malformed") {
      const before = await creditOwnershipState(pool);
      await expect(persist(delta)).rejects.toThrow("cannot be projected");
      expect(await creditOwnershipState(pool)).toEqual(before);
      return;
    }
    await persist(delta);
    const after = await creditOwnershipState(pool);
    expect(after.applications).toHaveLength(1);
    expect(after.applications[0]).toMatchObject({ status: action === "changed" ? "applied" : "voided",
      applied_amount: action === "changed" ? "1800.00" : "1861.52" });
    expect(after.documents.map(row => row.open_amount)).toEqual(action === "changed" ? ["61.52", "61.52"] : ["1861.52", "1861.52"]);
    await persist(delta);
    expect(await creditOwnershipState(pool)).toEqual(after);
  });

  it.each([false, true])("removes only directly owned LinkedTxn applications (customer=%s)", async (customer) => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:direct-credit-ownership" });
    const { facts, resources } = await creditOwnershipFixture(pool, customer);
    const documents = resources.operationalDocuments?.filter(row => row.resourceId !== "2574").map(row => ({
      ...row, resource: { ...row.resource, openAmount: row.resourceId === "2572" ? "1902.58" : "1841.52",
        lines: row.resource.lines.flatMap(line => row.resourceId === "2572" ? [{ ...line,
          sourceAmount: "20.00", linkedTransactions: [{ sourceTransactionId: "2573", sourceTransactionType: customer ? "Invoice" : "Bill" }]
        }, { ...line, sourceLineId: "2", lineNumber: 2, sourceAmount: "1902.58" }] : [line]) }
    }));
    await runner.transaction(client => persistQuickBooksSubledgerResources({ client, companyId: "company_qbo", facts,
      resources: { ...resources, operationalDocuments: documents ?? [] }, importedAt: "2026-09-11T10:00:00.000Z" }));
    // Same source document is not ownership: native, another provider object,
    // and a wrapper projection must all survive the ordinary credit refresh.
    for (const [id, payload] of [
      ["native", { provider: "native", sourceTransactionId: "2572" }],
      ["other", { provider: "quickbooks", sourceTransactionId: "other-object" }],
      ["projection", { provider: "quickbooks", sourceTransactionId: "2572", projectionKind: customer ? "customer_credit_application" : "vendor_credit_application" }]
    ] as const) {
      await pool.query(`insert into erp_financials.financial_lifecycle_events
        (event_id, tenant_id, company_id, source_id, aggregate_id, aggregate_type, event_type, occurred_at, recorded_at,
          idempotency_key, payload, payload_checksum, actor_ref, request_id, correlation_id, reason_code)
        select $1, tenant_id, company_id, source_id, $1, aggregate_type, event_type, occurred_at, recorded_at,
          $1, $2::jsonb, payload_checksum, actor_ref, $1, $1, reason_code
        from erp_financials.financial_lifecycle_events where event_type = 'quickbooks_application_imported' limit 1`, [id, JSON.stringify(payload)]);
      await pool.query(`insert into erp_financials.subledger_applications (
        subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
        target_document_id, applied_amount, currency_code, application_date, status, version,
        idempotency_key, applied_event_id, created_at, updated_at)
        select $1, tenant_id, company_id, source_id, application_type, source_document_id, target_document_id,
        1, currency_code, application_date, 'applied', 1, $1, $1, created_at, updated_at
        from erp_financials.subledger_applications where subledger_application_id not in ('native', 'other', 'projection') limit 1`, [id]);
    }
    const delta = resources.operationalDocuments?.filter(row => row.resourceId === "2572");
    await runner.transaction(client => persistQuickBooksSubledgerResources({ client, companyId: "company_qbo", facts,
      resources: { ...resources, operationalDocuments: delta ?? [] }, importedAt: "2026-09-11T11:00:00.000Z" }));
    const state = await creditOwnershipState(pool);
    expect(state.applications.filter(row => row.status === "applied").map(row => row.subledger_application_id).sort())
      .toEqual(["native", "other", "projection"]);
    expect(state.applications.filter(row => row.status === "voided")).toHaveLength(1);
  });

  it("persists and idempotently replays a zero-cash BillPayment as a vendor-credit application", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:quickbooks-credit-only-bill-payment" });
    await seedQuickBooksAllDocumentScope(pool);
    const baseFacts = quickBooksAllDocumentFacts();
    const baseResources = quickBooksAllDocumentResources();
    const resources: HandrailQuickBooksSdkResourceSet = {
      ...baseResources,
      operationalDocuments: baseResources.operationalDocuments?.map((resource) => {
        if (resource.resource.sourceTransactionId === "vendor_credit_all") {
          return {
            ...resource,
            resource: {
              ...resource.resource,
              lines: resource.resource.lines.map((line) => ({ ...line, linkedTransactions: [] }))
            }
          };
        }
        if (resource.resource.sourceTransactionId !== "bill_payment_all") return resource;
        const line = resource.resource.lines[0];
        if (line === undefined) throw new Error("BillPayment integration fixture requires a line.");
        return {
          ...resource,
          resource: {
            ...resource.resource,
            totalAmount: "0.00",
            openAmount: "0.00",
            unappliedAmount: "0.00",
            lines: [
              {
                ...line,
                sourceLineId: "bill-payment-credit-line",
                lineNumber: 1,
                sourceAmount: "10.00",
                linkedTransactions: [{
                  sourceTransactionId: "vendor_credit_all",
                  sourceTransactionType: "VendorCredit"
                }],
                postings: []
              },
              {
                ...line,
                sourceLineId: "bill-payment-bill-line",
                lineNumber: 2,
                sourceAmount: "10.00",
                linkedTransactions: [{ sourceTransactionId: "bill_all", sourceTransactionType: "Bill" }],
                postings: []
              }
            ]
          }
        };
      })
    };
    const facts: CanonicalAccountingFactSet = {
      ...baseFacts,
      transactions: baseFacts.transactions.filter((transaction) =>
        transaction.sourceTransactionId !== "bill_payment_all"
      )
    };
    const persist = (importedAt: string) => runner.transaction((client) =>
      persistQuickBooksSubledgerResources({ client, companyId: "company_qbo", importedAt, facts, resources })
    );

    await expect(persist("2026-08-10T10:01:00.000Z")).resolves.toMatchObject({
      documents: 10,
      applications: 3,
      skippedApplications: 0
    });
    const application = await pool.query<{
      application_type: string;
      source_type: string;
      target_type: string;
      applied_amount: string;
    }>(`
select application.application_type,
  source.metadata ->> 'sourceTransactionType' as source_type,
  target.metadata ->> 'sourceTransactionType' as target_type,
  application.applied_amount::text
from erp_financials.subledger_applications application
join erp_financials.subledger_documents source
  on source.subledger_document_id = application.source_document_id
join erp_financials.subledger_documents target
  on target.subledger_document_id = application.target_document_id
join erp_financials.financial_lifecycle_events event
  on event.event_id = application.applied_event_id
where event.payload ->> 'sourceTransactionId' = 'bill_payment_all'
`);
    expect(application.rows).toEqual([{
      application_type: "vendor_credit_to_bill",
      source_type: "VendorCredit",
      target_type: "Bill",
      applied_amount: "10.00"
    }]);
    await expect(persist("2026-08-10T10:02:00.000Z")).resolves.toMatchObject({
      documents: 0,
      applications: 0,
      skippedApplications: 0
    });
  });

  it("persists, replays, revises, and voids a zero-cash Payment credit application without cash activity", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:quickbooks-customer-credit-payment" });
    await seedQuickBooksImportScope(pool);
    await pool.query(`
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type,
  transaction_number, transaction_date, posted_at, updated_at, party_id, currency_code, status,
  source_payload_ref
) values (
  'transaction_credit_qbo', 'tenant_qbo', 'source_qbo', 'credit_73', 'CreditMemo', 'CM-73',
  '2026-08-09', '2026-08-09T12:00:00Z', '2026-08-10T10:00:00Z', 'customer_qbo', 'USD', 'posted', '{}'::jsonb
)
`);
    const baseFacts = quickBooksSubledgerFacts();
    const invoiceFact = baseFacts.transactions.find((transaction) => transaction.sourceTransactionId === "invoice_600");
    if (invoiceFact === undefined) throw new Error("Customer-credit integration fixture requires an invoice fact.");
    const facts: CanonicalAccountingFactSet = {
      ...baseFacts,
      transactions: [
        invoiceFact,
        {
          ...invoiceFact,
          transactionId: "transaction_credit_qbo",
          sourceTransactionId: "credit_73",
          sourceTransactionType: "CreditMemo",
          transactionNumber: "CM-73",
          transactionDate: "2026-08-09"
        }
      ],
      postings: []
    };
    const baseResources = quickBooksSubledgerResources("40.00", true, "2026-08-10T10:00:00.000Z");
    const invoiceTemplate = baseResources.operationalDocuments?.find((resource) =>
      resource.resource.sourceTransactionType === "Invoice"
    );
    const paymentTemplate = baseResources.operationalDocuments?.find((resource) =>
      resource.resource.sourceTransactionType === "Payment"
    );
    const lineTemplate = paymentTemplate?.resource.lines[0];
    if (invoiceTemplate === undefined || paymentTemplate === undefined || lineTemplate === undefined) {
      throw new Error("Customer-credit integration fixture requires invoice, payment, and line templates.");
    }
    const resourcesAt = (
      amount: string,
      sourceUpdatedAt: string,
      syncAction?: "voided"
    ): HandrailQuickBooksSdkResourceSet => {
      const invoice = {
        ...invoiceTemplate,
        sourceUpdatedAt,
        resource: {
          ...invoiceTemplate.resource,
          openAmount: syncAction === "voided" ? "100.00" : (amount === "40.00" ? "60.00" : "70.00"),
          sourceUpdatedAt
        }
      };
      const creditMemo = {
        ...invoiceTemplate,
        sourceUpdatedAt,
        resourceId: "credit_73",
        resource: {
          ...invoiceTemplate.resource,
          sourceTransactionId: "credit_73",
          sourceTransactionType: "CreditMemo",
          transactionNumber: "CM-73",
          transactionDate: "2026-08-09",
          totalAmount: "40.00",
          openAmount: syncAction === "voided" ? "40.00" : (amount === "40.00" ? "0.00" : "10.00"),
          sourceUpdatedAt,
          lines: []
        }
      };
      const payment = {
        ...paymentTemplate,
        sourceUpdatedAt,
        ...(syncAction === undefined ? {} : { syncAction }),
        resource: {
          ...paymentTemplate.resource,
          sourceTransactionId: "payment_700",
          sourceTransactionType: "Payment",
          totalAmount: "0.00",
          openAmount: "0.00",
          unappliedAmount: "0.00",
          sourceUpdatedAt,
          lines: [
            {
              ...lineTemplate,
              sourceLineId: "credit-line",
              lineNumber: 1,
              sourceAmount: amount,
              linkedTransactions: [{ sourceTransactionId: "credit_73", sourceTransactionType: "CreditMemo" }],
              postings: []
            },
            {
              ...lineTemplate,
              sourceLineId: "invoice-line",
              lineNumber: 2,
              sourceAmount: amount,
              linkedTransactions: [{ sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice" }],
              postings: []
            }
          ]
        }
      };
      return {
        ...baseResources,
        operationalDocuments: syncAction === "voided" ? [payment] : [invoice, creditMemo, payment]
      };
    };
    const persist = (
      resources: HandrailQuickBooksSdkResourceSet,
      importedAt: string,
      replaceMissingDocuments = false
    ) => runner.transaction((client) => persistQuickBooksSubledgerResources({
      client, companyId: "company_qbo", importedAt, facts, resources, replaceMissingDocuments
    }));

    const fullResources = resourcesAt("40.00", "2026-08-10T10:00:00.000Z");
    await expect(persist(fullResources, "2026-08-10T10:01:00.000Z", true)).resolves.toMatchObject({
      documents: 2,
      applications: 1,
      removedLedgerPostings: 0
    });
    await expect(persist(fullResources, "2026-08-10T10:02:00.000Z", true)).resolves.toMatchObject({
      documents: 0,
      applications: 0,
      removedLedgerPostings: 0
    });
    await expect(persist(
      resourcesAt("30.00", "2026-08-11T10:00:00.000Z"),
      "2026-08-11T10:01:00.000Z"
    )).resolves.toMatchObject({ applications: 1, removedLedgerPostings: 0 });
    await expect(persist(
      resourcesAt("30.00", "2026-08-12T10:00:00.000Z", "voided"),
      "2026-08-12T10:01:00.000Z"
    )).resolves.toMatchObject({ applications: 0, removedLedgerPostings: 0 });
    await expect(persist(
      resourcesAt("30.00", "2026-08-12T10:00:00.000Z", "voided"),
      "2026-08-12T10:02:00.000Z"
    )).resolves.toMatchObject({ applications: 0, removedLedgerPostings: 0 });

    const application = await pool.query<{
      application_type: string;
      applied_amount: string;
      status: string;
      version: number;
      source_type: string;
      target_type: string;
      projection_kind: string;
      wrapper_source_id: string;
    }>(`
select application.application_type, application.applied_amount::text, application.status, application.version,
  source.document_type as source_type, target.document_type as target_type,
  event.payload ->> 'projectionKind' as projection_kind,
  event.payload ->> 'sourceTransactionId' as wrapper_source_id
from erp_financials.subledger_applications application
join erp_financials.subledger_documents source on source.subledger_document_id = application.source_document_id
join erp_financials.subledger_documents target on target.subledger_document_id = application.target_document_id
join erp_financials.financial_lifecycle_events event on event.event_id = application.applied_event_id
where event.payload ->> 'sourceTransactionId' = 'payment_700'
`);
    expect(application.rows).toEqual([{
      application_type: "credit_to_invoice",
      applied_amount: "30.00",
      status: "voided",
      version: 3,
      source_type: "credit_memo",
      target_type: "invoice",
      projection_kind: "customer_credit_application",
      wrapper_source_id: "payment_700"
    }]);
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "credit_73", original_amount: "40.00", open_amount: "40.00", status: "open" },
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "100.00", status: "open" }
    ]);
    const cashImpact = await pool.query<{ count: string }>(`
select count(*)::text
from erp_financials.ledger_postings posting
join erp_financials.transactions transaction on transaction.transaction_id = posting.transaction_id
where transaction.source_transaction_id = 'payment_700'
`);
    expect(cashImpact.rows[0]?.count).toBe("0");
  });

  it("retires deleted delta documents and documents missing from an authoritative full snapshot", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:quickbooks-retirement" });
    await seedQuickBooksImportScope(pool);
    const facts = quickBooksSubledgerFacts();
    await runner.transaction((client) => persistQuickBooksSubledgerResources({
      client,
      companyId: "company_qbo",
      importedAt: "2026-08-10T10:01:00.000Z",
      facts,
      resources: quickBooksSubledgerResources("40.00", true, "2026-08-10T10:00:00.000Z")
    }));
    await pool.query(`
insert into erp_financials.transaction_lines (
  transaction_line_id, tenant_id, source_id, transaction_id, line_number, account_id, amount, dimension_refs
) values
  ('qbo_invoice_line', 'tenant_qbo', 'source_qbo', 'transaction_invoice_qbo', 1, 'account_revenue_qbo', 100, '[]'::jsonb),
  ('qbo_payment_line', 'tenant_qbo', 'source_qbo', 'transaction_payment_qbo', 1, 'account_cash_qbo', 40, '[]'::jsonb);
insert into erp_financials.ledger_postings (
  posting_id, tenant_id, source_id, source_posting_id, transaction_id, transaction_line_id,
  account_id, posting_date, accounting_basis, debit_amount, credit_amount, net_amount, currency_code,
  dimension_hash, dimension_refs,
  import_batch_id, source_payload_ref
) values
  ('qbo_invoice_posting', 'tenant_qbo', 'source_qbo', 'invoice-posting', 'transaction_invoice_qbo',
   'qbo_invoice_line', 'account_revenue_qbo', '2026-08-01', 'accrual', 0, 100, -100, 'USD', repeat('0', 64), '[]'::jsonb, 'batch_qbo', '{}'::jsonb),
  ('qbo_invoice_offset', 'tenant_qbo', 'source_qbo', 'invoice-offset', 'transaction_invoice_qbo',
   null, 'account_cash_qbo', '2026-08-01', 'accrual', 100, 0, 100, 'USD', repeat('0', 64), '[]'::jsonb, 'batch_qbo', '{}'::jsonb),
  ('qbo_payment_posting', 'tenant_qbo', 'source_qbo', 'payment-posting', 'transaction_payment_qbo',
   'qbo_payment_line', 'account_cash_qbo', '2026-08-10', 'accrual', 40, 0, 40, 'USD', repeat('0', 64), '[]'::jsonb, 'batch_qbo', '{}'::jsonb),
  ('qbo_payment_offset', 'tenant_qbo', 'source_qbo', 'payment-offset', 'transaction_payment_qbo',
   null, 'account_revenue_qbo', '2026-08-10', 'accrual', 0, 40, -40, 'USD', repeat('0', 64), '[]'::jsonb, 'batch_qbo', '{}'::jsonb);
`);

    const deltaResources = quickBooksSubledgerResources("40.00", true, "2026-08-11T10:00:00.000Z");
    const deletedPayment = {
      ...deltaResources,
      operationalDocuments: deltaResources.operationalDocuments?.map((resource) =>
        resource.resource.sourceTransactionId === "payment_700"
          ? { ...resource, syncAction: "deleted" as const }
          : resource
      )
    };
    const delta = await runner.transaction((client) => persistQuickBooksSubledgerResources({
      client,
      companyId: "company_qbo",
      importedAt: "2026-08-11T10:01:00.000Z",
      facts,
      resources: deletedPayment
    }));
    expect(delta).toMatchObject({ voidedDocuments: 1, removedLedgerPostings: 2 });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "100.00", status: "open" },
      { source_id: "payment_700", original_amount: "40.00", open_amount: "0", status: "voided" }
    ]);

    const invoiceOnly = {
      ...quickBooksSubledgerResources("40.00", false, "2026-08-12T10:00:00.000Z"),
      operationalDocuments: quickBooksSubledgerResources("40.00", false, "2026-08-12T10:00:00.000Z")
        .operationalDocuments?.filter((resource) => resource.resource.sourceTransactionId === "payment_700")
    };
    const full = await runner.transaction((client) => persistQuickBooksSubledgerResources({
      client,
      companyId: "company_qbo",
      importedAt: "2026-08-12T10:01:00.000Z",
      facts,
      resources: invoiceOnly,
      replaceMissingDocuments: true
    }));
    expect(full).toMatchObject({ voidedDocuments: 1, removedLedgerPostings: 2 });
    await expect(quickBooksDocumentState(pool)).resolves.toEqual([
      { source_id: "invoice_600", original_amount: "100.00", open_amount: "0", status: "voided" },
      { source_id: "payment_700", original_amount: "40.00", open_amount: "40.00", status: "open" }
    ]);
  });

  it("reads canonical journal and fiscal controls through the public SDK", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:accounting-control-reads" });
    await seedAccountingScope(pool);
    const sdk = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_primary",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-31T23:30:00.000Z"
    });
    await sdk.books.define({
      operation: { ...sdkOperation(), requestId: "request:book" },
      bookId: "book_primary",
      name: "Primary",
      baseCurrencyCode: "USD"
    });
    await sdk.books.bindSource({
      operation: { ...sdkOperation(), requestId: "request:book-source" },
      bookId: "book_primary",
      sourceId: "source_1",
      sourceRole: "active",
      effectiveFrom: "2026-01-01"
    });
    const posted = await sdk.commands.journalEntries.post({
      operation: { ...sdkOperation(), requestId: "request:journal" },
      idempotencyKey: "integration-journal-read",
      date: "2026-08-15",
      transactionNumber: "JE-INTEGRATION-1",
      memo: "Accrued service revenue",
      lines: [
        { accountId: "account_ar", debit: "125.50" },
        { accountId: "account_income", credit: "125.50" }
      ]
    });
    const defined = await sdk.commands.fiscalPeriods.define({
      operation: { ...sdkOperation(), requestId: "request:period-define" },
      fiscalYear: 2026,
      periodNumber: 8,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31"
    });
    const closing = await sdk.commands.fiscalPeriods.beginClose({
      operation: { ...sdkOperation(), requestId: "request:period-begin-close" },
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: defined.version
    });
    const evidenceMaterial = {
      trialBalanceSnapshotId: "trial_balance_integration",
      reconciliationRefs: ["reconciliation_integration"],
      checklistRef: "checklist_integration",
      postingMaxUpdatedAt: "2026-08-31T23:00:00.000Z"
    } as const;
    await sdk.commands.fiscalPeriods.close({
      operation: { ...sdkOperation(), requestId: "request:period-close" },
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: closing.version,
      evidence: { ...evidenceMaterial, evidenceChecksum: createFiscalCloseEvidenceChecksum(evidenceMaterial) }
    });

    await expect(sdk.queries.listJournalEntries({ limit: 25 })).resolves.toMatchObject({
      items: [{ journalEntryId: posted.transactionId, totalDebit: "125.50", totalCredit: "125.50", version: 1 }]
    });
    await expect(sdk.queries.getJournalEntry(posted.transactionId)).resolves.toMatchObject({
      journalEntryId: posted.transactionId,
      lines: [{ debitAmount: "125.50" }, { creditAmount: "125.50" }]
    });
    await expect(sdk.queries.getFiscalPeriod("source_1", defined.fiscalPeriodId)).resolves.toMatchObject({
      status: "closed",
      version: 3,
      closeEvidence: { trialBalanceSnapshotId: "trial_balance_integration" }
    });
    await expect(sdk.queries.getPostingLock("source_1")).resolves.toMatchObject({
      postingLockDate: "2026-08-31",
      version: 1
    });
  });

  it("reads both sides of the QuickBooks-to-Spartan cutoff through one reporting book", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:cutoff-continuity" });
    await seedAccountingScope(pool);
    await pool.query(`
update erp_financials.accounting_sources set source_system = 'quickbooks' where source_id = 'source_1';
insert into erp_financials.company_sources values ('company_source_2', 'tenant_1', 'company_1', 'source_2', now());
insert into erp_financials.accounts (account_id, tenant_id, source_id, source_account_id, name, type, classification, active)
values ('native_cash', 'tenant_1', 'source_2', 'cash', 'Cash', 'Bank', 'asset', true),
       ('native_ar', 'tenant_1', 'source_2', 'ar', 'Receivable', 'Accounts Receivable', 'asset', true),
       ('native_ap', 'tenant_1', 'source_2', 'ap', 'Payable', 'Accounts Payable', 'liability', true),
       ('native_income', 'tenant_1', 'source_2', 'income', 'Service Revenue', 'Income', 'income', true);
insert into erp_financials.parties (party_id, tenant_id, source_id, source_party_id, party_type, display_name, active)
values ('native_customer', 'tenant_1', 'source_2', 'customer:1', 'customer', 'Customer One', true),
       ('native_vendor', 'tenant_1', 'source_2', 'vendor:1', 'vendor', 'Vendor One', true);
`);
    const operation = sdkOperation();
    const sdk = createErpFinancialsSdk({
      database: runner, tenantId: "tenant_1", companyId: "company_1", bookId: "book_cutoff",
      writeSourceId: "source_2", currencyCode: "USD", postingPolicy: "legacy_unrestricted",
      now: () => "2026-09-02T12:00:00.000Z"
    });
    await sdk.books.define({ operation, bookId: "book_cutoff", name: "Cutoff book", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({
      operation, bookId: "book_cutoff", sourceId: "source_1", sourceRole: "historical",
      effectiveThrough: "2026-08-31"
    });
    await sdk.books.bindSource({
      operation, bookId: "book_cutoff", sourceId: "source_2", sourceRole: "active",
      effectiveFrom: "2026-09-01"
    });
    for (const account of [
      { bookAccountKey: "cash", accountNumber: "1000", name: "Cash", classification: "asset" as const },
      { bookAccountKey: "receivable", accountNumber: "1100", name: "Accounts receivable", classification: "asset" as const },
      { bookAccountKey: "payable", accountNumber: "2000", name: "Accounts payable", classification: "liability" as const },
      { bookAccountKey: "revenue", accountNumber: "4000", name: "Service revenue", classification: "income" as const },
    ]) {
      await sdk.books.defineAccount({ operation, bookId: "book_cutoff", expectedVersion: 0, accountRole: "posting", type: account.name, ...account });
    }
    for (const mapping of [
      ["source_1", "account_cash", "cash"], ["source_1", "account_ar", "receivable"],
      ["source_1", "account_ap", "payable"], ["source_1", "account_income", "revenue"],
      ["source_2", "native_cash", "cash"], ["source_2", "native_ar", "receivable"],
      ["source_2", "native_ap", "payable"], ["source_2", "native_income", "revenue"],
    ] as const) {
      await sdk.books.mapAccount({ operation, bookId: "book_cutoff", sourceId: mapping[0], accountId: mapping[1], bookAccountKey: mapping[2] });
    }
    const qbo = createErpFinancials({
      database: runner, tenantId: "tenant_1", companyId: "company_1", sourceId: "source_1",
      currencyCode: "USD", postingPolicy: "legacy_unrestricted", now: () => "2026-08-31T23:00:00.000Z"
    });
    const native = createErpFinancials({
      database: runner, tenantId: "tenant_1", companyId: "company_1", sourceId: "source_2",
      currencyCode: "USD", postingPolicy: "legacy_unrestricted", now: () => "2026-09-01T12:00:00.000Z"
    });
    await qbo.invoices.create({
      operation, idempotencyKey: "cutoff-qbo-invoice", date: "2026-08-31", dueDate: "2026-09-30",
      customerId: "customer_1", receivableAccount: { accountId: "account_ar" },
      revenueLines: [{ accountId: "account_income", amount: "100.00" }]
    });
    await qbo.vendorBills.create({
      operation, idempotencyKey: "cutoff-qbo-bill", date: "2026-08-31", dueDate: "2026-09-30",
      vendorId: "vendor_1", payableAccount: { accountId: "account_ap" },
      expenseLines: [{ accountId: "account_cash", amount: "40.00" }]
    });
    await expect(native.invoices.create({
      operation: { ...operation, requestId: "cutoff-backdated-native" },
      idempotencyKey: "cutoff-backdated-native", date: "2026-08-31", dueDate: "2026-09-30",
      customerId: "native_customer", receivableAccount: { accountId: "native_ar" },
      revenueLines: [{ accountId: "native_income", amount: "1.00" }]
    })).rejects.toThrow("outside every reporting-book window");
    await native.invoices.create({
      operation, idempotencyKey: "cutoff-native-invoice", date: "2026-09-01", dueDate: "2026-10-01",
      customerId: "native_customer", receivableAccount: { accountId: "native_ar" },
      revenueLines: [{ accountId: "native_income", amount: "100.00" }]
    });
    await native.vendorBills.create({
      operation, idempotencyKey: "cutoff-native-bill", date: "2026-09-01", dueDate: "2026-10-01",
      vendorId: "native_vendor", payableAccount: { accountId: "native_ap" },
      expenseLines: [{ accountId: "native_cash", amount: "40.00" }]
    });

    const window = { periodStart: "2026-08-31" as const, periodEnd: "2026-09-01" as const };
    const ledger = await sdk.queries.listGeneralLedger({ ...window, limit: 100 });
    expect(new Set(ledger.items.map((line) => line.sourceProvenance.sourceId))).toEqual(new Set(["source_1", "source_2"]));
    await expect(sdk.queries.getGeneralLedgerSummary(window)).resolves.toMatchObject({
      postingCount: 8, totalDebits: "280.00", totalCredits: "280.00", difference: "0.00"
    });
    await expect(sdk.queries.getFinancialStatement({ reportName: "profit_and_loss", ...window })).resolves.toMatchObject({
      totals: { income: "200.00" }
    });
    await expect(sdk.queries.getFinancialStatement({ reportName: "balance_sheet", ...window, asOfDate: "2026-09-01" })).resolves.toMatchObject({
      reportName: "balance_sheet",
      totals: { difference: "0.00" }
    });
    await expect(sdk.queries.getFinancialStatement({ reportName: "trial_balance", ...window, asOfDate: "2026-09-01" })).resolves.toMatchObject({
      reportName: "trial_balance"
    });
    await expect(sdk.queries.getAging({ kind: "receivables", asOfDate: "2026-09-01" })).resolves.toMatchObject({
      totals: { total: "200.00" }
    });
    await expect(sdk.queries.getAging({ kind: "payables", asOfDate: "2026-09-01" })).resolves.toMatchObject({
      totals: { total: "80.00" }
    });
  });

  it("upgrades a real v6 database through the scoped v7 migration before continuing", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:v6", targetVersion: 6 });
    await expect(snapshotScopeColumns(pool)).resolves.toEqual([]);

    const v7 = await migratePostgresSchema(runner, { appliedByRef: "integration:v7", targetVersion: 7 });

    expect(v7.currentVersion).toBe(6);
    expect(v7.applied.map((migration) => migration.toVersion)).toEqual([7]);
    await expect(snapshotScopeColumns(pool)).resolves.toEqual(["company_id", "source_id"]);
  });

  it("rolls back every DDL and ledger row when an ordered migration fails", async () => {
    const failingRunner: PostgresMigrationTransactionRunner = {
      transaction: (work) =>
        runner.transaction((client) =>
          work(new FailingMigrationClient(client, 'create table "erp_financials"."company_sources"'))
        )
    };

    await expect(
      migratePostgresSchema(failingRunner, { appliedByRef: "integration:rollback" })
    ).rejects.toThrow("injected real migration failure");

    const relation = await pool.query<{ relation_name: string | null }>(
      "select to_regclass('erp_financials.report_snapshots') as relation_name"
    );
    expect(relation.rows[0]?.relation_name).toBeNull();
  });

  it("enforces scoped foreign keys, posting arithmetic, and immutable posted journal facts", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:constraints" });
    await seedAccountingScope(pool);

    await pool.query(`
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type, transaction_date,
  posted_at, updated_at, currency_code, status, source_payload_ref
) values
  ('journal_reversal_1', 'tenant_1', 'source_1', 'reversal:1', 'JournalEntryAdjustment', '2026-08-02', now(), now(), 'USD', 'posted', '{}'::jsonb),
  ('journal_reversal_2', 'tenant_1', 'source_1', 'reversal:2', 'JournalEntryAdjustment', '2026-08-03', now(), now(), 'USD', 'posted', '{}'::jsonb);
insert into erp_financials.financial_lifecycle_events values
  ('event_reversal_1', 'tenant_1', 'company_1', 'source_1', 'journal_entry', 'journal_1', 'reversed', 'user:1', 'user:2', 'request:r1', 'correlation:r', 'test', null, now(), now(), 'event_reversal_1', repeat('a',64), '{}'::jsonb, null),
  ('event_reversal_2', 'tenant_1', 'company_1', 'source_1', 'journal_entry', 'journal_1', 'voided', 'user:1', 'user:2', 'request:r2', 'correlation:r', 'test', null, now(), now(), 'event_reversal_2', repeat('a',64), '{}'::jsonb, null);
insert into erp_financials.journal_entry_links values
  ('link_reversal_1', 'tenant_1', 'company_1', 'source_1', 'journal_1', 'journal_reversal_1', 'reversal', 'event_reversal_1', now());
`);
    await expect(
      pool.query(
        "insert into erp_financials.journal_entry_links values ('link_reversal_2', 'tenant_1', 'company_1', 'source_1', 'journal_1', 'journal_reversal_2', 'void', 'event_reversal_2', now())"
      )
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      pool.query(
        `insert into erp_financials.accounts (
  account_id, tenant_id, source_id, source_account_id, name, type, classification, parent_account_id, active
) values ('account_cross_scope', 'tenant_1', 'source_2', 'cross', 'Cross scope', 'asset', 'asset', 'account_cash', true)`
      )
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool.query(
        `insert into erp_financials.ledger_postings (
  posting_id, tenant_id, source_id, source_posting_id, transaction_id, transaction_line_id, account_id,
  posting_date, accounting_basis, debit_amount, credit_amount, net_amount, currency_code, dimension_hash,
  dimension_refs, import_batch_id
) values (
  'posting_bad', 'tenant_1', 'source_1', 'bad', 'journal_1', 'line_1', 'account_cash',
  '2026-08-01', 'accrual', 10, 2, 8, 'USD', repeat('a', 64), '[]'::jsonb, 'batch_1'
)`
      )
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `insert into erp_financials.ledger_postings (
  posting_id, tenant_id, source_id, source_posting_id, transaction_id, transaction_line_id, account_id,
  posting_date, accounting_basis, debit_amount, credit_amount, net_amount, currency_code, dimension_hash,
  dimension_refs, import_batch_id
) values (
  'posting_1', 'tenant_1', 'source_1', 'good', 'journal_1', 'line_1', 'account_cash',
  '2026-08-01', 'accrual', 10, 0, 10, 'USD', repeat('a', 64), '[]'::jsonb, 'batch_1'
)`
    );
    await expect(
      pool.query("update erp_financials.transactions set memo = 'changed' where transaction_id = 'journal_1'")
    ).rejects.toThrow("posted journal entries are immutable");
    await expect(
      pool.query("delete from erp_financials.ledger_postings where posting_id = 'posting_1'")
    ).rejects.toThrow("posted journal entry facts are immutable");
  });

  it("serializes advisory locks and preserves repeatable-read snapshot isolation", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:locks" });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("begin isolation level repeatable read");
      await second.query("begin");
      await first.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["integration:lock"]);
      const unavailable = await second.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
        ["integration:lock"]
      );
      expect(unavailable.rows[0]?.acquired).toBe(false);

      const before = await first.query<{ count: string }>("select count(*)::text as count from erp_financials.schema_migrations");
      await second.query("insert into erp_financials.schema_migrations values ('integration_probe', 14, 15, 'probe', repeat('b', 64), 'probe', 0, 'integration', clock_timestamp())");
      await second.query("commit");
      const during = await first.query<{ count: string }>("select count(*)::text as count from erp_financials.schema_migrations");
      expect(during.rows[0]?.count).toBe(before.rows[0]?.count);
      await first.query("rollback");

      const third = await pool.connect();
      try {
        await third.query("begin");
        const available = await third.query<{ acquired: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
          ["integration:lock"]
        );
        expect(available.rows[0]?.acquired).toBe(true);
        await third.query("rollback");
      } finally {
        third.release();
      }
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("atomically enforces application balance, party, currency, terminal state, and unapply restoration", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:applications" });
    await seedAccountingScope(pool);
    await seedSubledgerDocuments(pool);

    await expect(
      pool.query(
        `insert into erp_financials.subledger_documents (
  subledger_document_id, tenant_id, company_id, source_id, document_type, transaction_id, party_id,
  document_date, currency_code, original_amount, open_amount, status, version, idempotency_key,
  lifecycle_event_id, metadata, created_at, updated_at
) values ('document_mismatched_journal', 'tenant_1', 'company_1', 'source_1', 'invoice', 'txn_payment',
  'customer_1', '2026-08-05', 'USD', 10, 10, 'open', 1, 'document_mismatched_journal',
  'event_payment', '{}'::jsonb, now(), now())`
      )
    ).rejects.toThrow("must match its posted journal type, currency, and party");

    await expect(
      pool.query(
        `insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, ended_event_id, created_at, updated_at
) values ('application_invalid_initial', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice',
  'payment_1', 'invoice_1', 1, 'USD', '2026-08-05', 'unapplied', 2, 'apply_invalid_initial',
  'event_apply', 'event_apply', now(), now())`
      )
    ).rejects.toThrow("must begin applied at version 1");

    await expect(
      pool.query(
        `insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values ('application_party', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice',
  'payment_other_party', 'invoice_1', 1, 'USD', '2026-08-05', 'applied', 1, 'apply_party', 'event_apply', now(), now())`
      )
    ).rejects.toThrow("same non-null party");
    await expect(
      pool.query(
        `insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values ('application_currency', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice',
  'payment_eur', 'invoice_1', 1, 'EUR', '2026-08-05', 'applied', 1, 'apply_currency', 'event_apply', now(), now())`
      )
    ).rejects.toThrow("currency must match");
    await expect(
      pool.query("update erp_financials.transactions set memo = 'changed' where transaction_id = 'txn_invoice'")
    ).rejects.toThrow("posted journal entries are immutable");
    await expect(
      pool.query("update erp_financials.subledger_documents set open_amount = 99 where subledger_document_id = 'invoice_1'")
    ).rejects.toThrow("posted subledger documents are immutable");

    await pool.query(
      `insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values (
  'application_1', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice', 'payment_1',
  'invoice_1', 60, 'USD', '2026-08-05', 'applied', 1, 'apply_1', 'event_apply', now(), now()
)`
    );
    await expect(documentBalances(pool)).resolves.toEqual([
      { subledger_document_id: "invoice_1", open_amount: "40", status: "partially_applied", version: 2 },
      { subledger_document_id: "payment_1", open_amount: "0", status: "settled", version: 2 }
    ]);

    await pool.query(
      `insert into erp_financials.financial_lifecycle_events values (
  'event_over', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_over', 'applied',
  'user:1', null, 'request:over', 'correlation:1', 'test', null, now(), now(), 'event_over', repeat('a',64), '{}'::jsonb, null
)`
    );
    await expect(
      pool.query(
        `insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values ('application_over', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice',
  'payment_1', 'invoice_1', 1, 'USD', '2026-08-05', 'applied', 1, 'apply_over', 'event_over', now(), now())`
      )
    ).rejects.toThrow("exceeds an available document balance");

    await pool.query(
      `insert into erp_financials.financial_lifecycle_events values (
  'event_unapply', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_1', 'unapplied',
  'user:1', 'user:2', 'request:unapply', 'correlation:1', 'test', null, now(), now(), 'event_unapply', repeat('a',64), '{}'::jsonb, 'event_apply'
)`
    );
    await expect(
      pool.query(
        "update erp_financials.subledger_applications set status = 'unapplied', version = 9, ended_event_id = 'event_unapply', updated_at = now() where subledger_application_id = 'application_1'"
      )
    ).rejects.toThrow("must increment version and timestamp");
    await pool.query(
      "update erp_financials.subledger_applications set status = 'unapplied', version = 2, ended_event_id = 'event_unapply', updated_at = now() where subledger_application_id = 'application_1'"
    );
    await expect(documentBalances(pool)).resolves.toEqual([
      { subledger_document_id: "invoice_1", open_amount: "100", status: "open", version: 3 },
      { subledger_document_id: "payment_1", open_amount: "60", status: "open", version: 3 }
    ]);
    await expect(
      pool.query("delete from erp_financials.subledger_applications where subledger_application_id = 'application_1'")
    ).rejects.toThrow("cannot be deleted");
  });

  it("reads bounded historical customer statements with scoped lifecycle evidence", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:customer-statement" });
    await seedAccountingScope(pool);
    await seedCustomerStatementScenario(pool);
    const sdk = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted"
    });

    const first = await sdk.queries.getCustomerStatement({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      limit: 1
    });
    expect(first.totals).toEqual({
      invoiceCount: 2,
      invoicedAmount: "130.00",
      appliedAmount: "90.00",
      outstandingAmount: "40.00"
    });
    expect(first.pageTotals).toEqual({
      invoiceCount: 1,
      invoicedAmount: "100.00",
      appliedAmount: "60.00",
      outstandingAmount: "40.00"
    });
    expect(first.items).toEqual([expect.objectContaining({
      invoiceId: "invoice_1",
      appliedAmount: "60.00",
      openBalance: "40.00",
      applications: [expect.objectContaining({
        applicationId: "application_1",
        status: "applied",
        endedLifecycleEventId: "event_statement_unapply"
      })]
    })]);
    if (first.nextCursor === undefined) throw new Error("Expected a customer statement cursor");

    const second = await sdk.queries.getCustomerStatement({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.items).toEqual([expect.objectContaining({
      invoiceId: "invoice_full",
      appliedAmount: "30.00",
      openBalance: "0.00"
    })]);
    expect(second.nextCursor).toBeUndefined();

    await expect(sdk.queries.getCustomerStatement({
      customerId: "customer_2",
      asOfDate: "2026-08-31",
      limit: 10
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ invoiceId: "invoice_other", customerId: "customer_2" })],
      totals: { invoiceCount: 1, invoicedAmount: "80.00", outstandingAmount: "80.00" }
    });

    const otherBook = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_2",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted"
    });
    await expect(otherBook.queries.getCustomerStatement({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      limit: 10
    })).resolves.toMatchObject({ items: [], totals: { invoiceCount: 0 } });

    const mutableBalance = await pool.query<{ open_amount: string }>(
      "select open_amount::text from erp_financials.subledger_documents where subledger_document_id = 'invoice_1'"
    );
    expect(mutableBalance.rows[0]?.open_amount).toBe("60");
  });

  it("atomically settles invoice write-offs and rejects locked application transitions", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:write-off-settlement" });
    await seedAccountingScope(pool);
    const unrestricted = createErpFinancials({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    const invoice = await unrestricted.invoices.create({
      operation: sdkOperation(),
      idempotencyKey: "integration-write-off-invoice",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_1",
      receivableAccount: { accountId: "account_ar" },
      revenueLines: [{ accountId: "account_income", amount: "40.00" }]
    });
    const settlementInput = {
      operation: sdkOperation(),
      idempotencyKey: "integration-write-off-settlement",
      date: "2026-08-08" as const,
      customerId: "customer_1",
      invoiceId: invoice.documentId,
      expectedInvoiceVersion: 1,
      amount: "15.00" as const,
      balanceAccount: { accountId: "account_ar" as const },
      writeOffAccount: { accountId: "account_income" as const },
      reason: "Approved integration write-off"
    };

    const settlement = await unrestricted.writeOffs.settleInvoice(settlementInput);
    await expect(unrestricted.writeOffs.settleInvoice(settlementInput)).resolves.toMatchObject({
      status: "already_settled",
      application: { status: "already_applied" }
    });
    expect(settlement).toMatchObject({
      status: "settled",
      invoiceOpenAmount: "25.00",
      invoiceStatus: "partially_applied",
      invoiceVersion: 2,
      writeOffVersion: 2,
      application: { appliedAmount: "15.00", version: 1 }
    });
    const facts = await pool.query<{
      application_type: string;
      invoice_open_amount: string;
      invoice_status: string;
      write_off_open_amount: string;
      write_off_status: string;
    }>(
      `select application.application_type,
  invoice.open_amount::text as invoice_open_amount, invoice.status as invoice_status,
  write_off.open_amount::text as write_off_open_amount, write_off.status as write_off_status
from erp_financials.subledger_applications application
join erp_financials.subledger_documents invoice on invoice.subledger_document_id = application.target_document_id
join erp_financials.subledger_documents write_off on write_off.subledger_document_id = application.source_document_id
where application.subledger_application_id = $1`,
      [settlement.application.applicationId]
    );
    expect(facts.rows).toEqual([{
      application_type: "write_off_to_invoice",
      invoice_open_amount: "25",
      invoice_status: "partially_applied",
      write_off_open_amount: "0",
      write_off_status: "settled"
    }]);

    await pool.query(
      `insert into erp_financials.fiscal_periods (
  fiscal_period_id, tenant_id, company_id, source_id, fiscal_year, period_number,
  period_start, period_end, status, version, created_at, updated_at
) values ('period_2026_08', 'tenant_1', 'company_1', 'source_1', 2026, 8,
  '2026-08-01', '2026-08-31', 'closing', 1, now(), now())`
    );
    const enforced = createErpFinancials({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "enforce_fiscal_periods",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    await expect(enforced.paymentApplications.unapply({
      operation: sdkOperation(),
      applicationId: settlement.application.applicationId,
      effectiveDate: "2026-08-08",
      expectedVersion: 1
    })).rejects.toMatchObject({ code: "fiscal_period_closing" });
    await expect(
      pool.query("select status, version from erp_financials.subledger_applications where subledger_application_id = $1", [
        settlement.application.applicationId
      ])
    ).resolves.toMatchObject({ rows: [{ status: "applied", version: 1 }] });
  });

  it("voids and reloads a canonical bill payment through real PostgreSQL", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:bill-payment-void" });
    await seedAccountingScope(pool);
    const sdk = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_primary",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    const operation = sdkOperation();
    await sdk.books.define({
      operation,
      bookId: "book_primary",
      name: "Primary",
      baseCurrencyCode: "USD"
    });
    await sdk.books.bindSource({
      operation,
      bookId: "book_primary",
      sourceId: "source_1",
      sourceRole: "active",
      effectiveFrom: "2026-01-01"
    });
    const payment = await sdk.commands.billPayments.record({
      operation,
      idempotencyKey: "integration-bill-payment",
      date: "2026-08-05",
      documentNumber: "PAY-100",
      memo: "Duplicate payment",
      vendorId: "vendor_1",
      amount: "20.00",
      payableAccount: { accountId: "account_ap" },
      cashAccount: { accountId: "account_cash" }
    });
    await expect(sdk.queries.listPayments({
      paymentType: "bill_payment",
      vendorId: "vendor_1",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      status: "unapplied"
    })).resolves.toMatchObject({
      items: [{ paymentId: payment.documentId, transactionId: payment.journal.transactionId, version: 1 }]
    });

    const command = {
      operation,
      billPaymentId: payment.documentId,
      expectedVersion: 1,
      idempotencyKey: "integration-void-bill-payment",
      date: "2026-08-12" as const,
      memo: "Void duplicate payment"
    };
    await expect(sdk.commands.billPayments.void(command)).resolves.toMatchObject({
      status: "voided",
      originalBillPaymentId: payment.documentId,
      originalVersion: 2
    });
    await expect(sdk.commands.billPayments.void(command)).resolves.toMatchObject({
      status: "already_voided",
      reversal: { status: "already_posted" }
    });
    await expect(sdk.queries.getBillPayment(payment.documentId)).resolves.toMatchObject({
      paymentId: payment.documentId,
      vendorId: "vendor_1",
      transactionId: payment.journal.transactionId,
      amount: "20.00",
      status: "voided",
      version: 2,
      memo: "Duplicate payment",
      lifecycle: {
        posted: { actorRef: operation.actorRef },
        voided: { actorRef: operation.actorRef, approverRef: operation.approverRef }
      },
      applications: []
    });
    await expect(sdk.queries.listPayments({
      paymentType: "bill_payment",
      vendorId: "vendor_1",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      status: "voided"
    })).resolves.toMatchObject({ items: [{ paymentId: payment.documentId, version: 2 }] });
  });

  it("round-trips four-place bill rates with cent-rounded extensions and exact replay", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:bill-unit-rates" });
    await seedAccountingScope(pool);
    const operation = sdkOperation();
    const sdk = createErpFinancialsSdk({
      database: runner, tenantId: "tenant_1", companyId: "company_1", bookId: "book_primary",
      writeSourceId: "source_1", currencyCode: "USD", postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    await sdk.books.define({ operation, bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: "book_primary", sourceId: "source_1", sourceRole: "active", effectiveFrom: "2026-01-01" });
    const lines = [
      { accountId: "account_cash", quantity: "723", unitAmount: "1.7472", amount: "1263.23" },
      { accountId: "account_cash", quantity: "600", unitAmount: "10.4832", amount: "6289.92" }
    ];
    const input: CreateVendorBillInput = {
      operation, idempotencyKey: "four-place-bill", date: "2026-08-01", dueDate: "2026-08-31",
      vendorId: "vendor_1", payableAccount: { accountId: "account_ap" }, expenseLines: lines
    };
    const bill = await sdk.commands.vendorBills.create(input);
    const detail = await sdk.queries.getVendorBill(bill.documentId, "2026-08-31");
    expect(detail.originalAmount).toBe("7553.15");
    expect(detail.lines).toMatchObject(lines);
    const stored = await pool.query(`select quantity::text, unit_amount::text, line_amount::text
from erp_financials.subledger_document_lines where subledger_document_id = $1 order by line_number`, [bill.documentId]);
    expect(stored.rows).toEqual([
      { quantity: "723", unit_amount: "1.7472", line_amount: "1263.23" },
      { quantity: "600", unit_amount: "10.4832", line_amount: "6289.92" }
    ]);
    await expect(sdk.commands.vendorBills.create(input)).resolves.toMatchObject({ documentId: bill.documentId, status: "already_posted" });
  });

  it("retains native bill-line customers through reads, replay, replacement, and void", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:bill-line-customers" });
    await seedAccountingScope(pool);
    const operation = sdkOperation();
    const sdk = createErpFinancialsSdk({
      database: runner, tenantId: "tenant_1", companyId: "company_1", bookId: "book_primary",
      writeSourceId: "source_1", currencyCode: "USD", postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    await sdk.books.define({ operation, bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({
      operation, bookId: "book_primary", sourceId: "source_1", sourceRole: "active", effectiveFrom: "2026-01-01"
    });
    const line = { accountId: "account_cash", amount: "10.00" };
    const input: CreateVendorBillInput = {
      operation, idempotencyKey: "bill-line-customers", date: "2026-08-01", dueDate: "2026-08-31",
      vendorId: "vendor_1", payableAccount: { accountId: "account_ap" },
      expenseLines: [{ ...line, customerId: "customer_1" }, line, { ...line, customerId: "customer_2" }]
    };
    const bill = await sdk.commands.vendorBills.create(input);
    const detail = await sdk.queries.getVendorBill(bill.documentId, "2026-08-31");
    expect(detail).toMatchObject({ vendorId: "vendor_1", originalAmount: "30.00", lines: [
      { lineNumber: 1, customerId: "customer_1", customerName: "Customer One", amount: "10.00" },
      { lineNumber: 2, amount: "10.00" },
      { lineNumber: 3, customerId: "customer_2", customerName: "Customer Two", amount: "10.00" }
    ] });
    expect(detail.lines[1]).not.toHaveProperty("customerId");
    await expect(sdk.commands.vendorBills.create(input)).resolves.toMatchObject({
      documentId: bill.documentId, status: "already_posted"
    });
    for (const expenseLines of [
      [{ ...line, customerId: "customer_2" }, line, { ...line, customerId: "customer_1" }],
      [line, line, line],
      [{ ...line, customerId: "customer_1" }, { ...line, customerId: "customer_1" }, { ...line, customerId: "customer_2" }]
    ]) {
      await expect(sdk.commands.vendorBills.create({ ...input, expenseLines }))
        .rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    const legacyInput = { ...input, idempotencyKey: "bill-without-customers", expenseLines: [line] };
    const legacy = await sdk.commands.vendorBills.create(legacyInput);
    await expect(sdk.commands.vendorBills.create(legacyInput)).resolves.toMatchObject({ status: "already_posted" });
    await expect(sdk.commands.vendorBills.create({
      ...legacyInput, expenseLines: [{ ...line, customerId: "customer_1" }]
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const stored = await pool.query(`select customer_party_id from erp_financials.subledger_document_lines
where subledger_document_id = $1`, [legacy.documentId]);
    expect(stored.rows).toEqual([{ customer_party_id: null }]);

    const replacementInput = {
      operation, vendorBillId: bill.documentId, expectedVersion: 1,
      idempotencyKey: "replace-customer-bill", date: "2026-08-12",
      replacement: { ...input, idempotencyKey: "replacement-customer-bill",
        expenseLines: [{ ...line, customerId: "customer_2" }] }
    };
    const replaced = await sdk.commands.vendorBills.replacePosted(replacementInput);
    if (replaced.replacement === undefined) throw new Error("Expected a replacement bill");
    const replacementId = replaced.replacement.documentId;
    await expect(sdk.commands.vendorBills.replacePosted(replacementInput))
      .resolves.toMatchObject({ status: "already_replaced" });
    await expect(sdk.commands.vendorBills.replacePosted({
      ...replacementInput,
      replacement: { ...replacementInput.replacement, expenseLines: [{ ...line, customerId: "customer_1" }] }
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(sdk.queries.getVendorBill(replacementId, "2026-08-31"))
      .resolves.toMatchObject({ lines: [{ customerId: "customer_2" }] });
    await sdk.commands.vendorBills.voidPosted({
      operation, vendorBillId: replacementId, expectedVersion: 1,
      idempotencyKey: "void-customer-bill", date: "2026-08-12"
    });
    const historicalLines = await pool.query(`select subledger_document_id, customer_party_id
from erp_financials.subledger_document_lines where subledger_document_id = any($1::text[])
order by subledger_document_id, line_number`, [[bill.documentId, replacementId]]);
    expect(historicalLines.rows).toEqual(expect.arrayContaining([
      { subledger_document_id: bill.documentId, customer_party_id: "customer_1" },
      { subledger_document_id: bill.documentId, customer_party_id: "customer_2" },
      { subledger_document_id: replacementId, customer_party_id: "customer_2" }
    ]));
  });

  it("validates native bill-line customer identity and scope and rolls back failed replacements", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:bill-line-customer-validation" });
    await seedAccountingScope(pool);
    await pool.query(`insert into erp_financials.accounting_sources
(source_id, tenant_id, source_system, provider_environment, connection_ref, status)
values ('source_other', 'tenant_other', 'native_erp', 'test', 'source:other', 'active');
insert into erp_financials.parties
(party_id, tenant_id, source_id, source_party_id, party_type, display_name, active) values
('inactive_customer', 'tenant_1', 'source_1', 'inactive', 'customer', 'Inactive', false),
('other_source_customer', 'tenant_1', 'source_2', 'other-source', 'customer', 'Other Source', true),
('other_tenant_customer', 'tenant_other', 'source_other', 'other-tenant', 'customer', 'Other Tenant', true)`);
    const financials = createErpFinancials({
      database: runner, tenantId: "tenant_1", companyId: "company_1", sourceId: "source_1",
      currencyCode: "USD", postingPolicy: "legacy_unrestricted", now: () => "2026-08-12T12:00:00.000Z"
    });
    const assignedLine = { accountId: "account_cash", amount: "10.00", customerId: "customer_1" };
    const input: CreateVendorBillInput = {
      operation: sdkOperation(), idempotencyKey: "validated-customer-bill", date: "2026-08-01", dueDate: "2026-08-31",
      vendorId: "vendor_1", payableAccount: { accountId: "account_ap" },
      expenseLines: [assignedLine]
    };
    const counts = async () => (await pool.query<Record<string, string>>(`select
(select count(*) from erp_financials.transactions) as transactions,
(select count(*) from erp_financials.ledger_postings) as postings,
(select count(*) from erp_financials.subledger_documents) as documents,
(select count(*) from erp_financials.subledger_document_lines) as lines,
(select count(*) from erp_financials.financial_lifecycle_events) as events,
(select count(*) from erp_financials.financial_outbox) as outbox`)).rows;
    const before = await counts();
    for (const customerId of ["missing", "vendor_1", "inactive_customer", "other_source_customer", "other_tenant_customer"]) {
      await expect(financials.vendorBills.create({
        ...input, expenseLines: [assignedLine, { ...assignedLine, customerId }]
      })).rejects.toMatchObject({ code: "missing_party" });
      expect(await counts()).toEqual(before);
    }
    for (const customerId of ["", "  "]) {
      await expect(financials.vendorBills.create({
        ...input, expenseLines: [{ ...assignedLine, customerId }]
      })).rejects.toThrow("customerId must not be empty");
    }
    for (const customerId of [null, 42, {}]) {
      await expect(financials.vendorBills.create({
        ...input, expenseLines: [{ ...assignedLine, customerId: customerId as unknown as string }]
      })).rejects.toThrow("customerId must be a string");
    }
    // Fail the second line at the SQL boundary after posting and the first line were written.
    await pool.query(`alter table erp_financials.subledger_document_lines add constraint test_reject_customer
check (customer_party_id is distinct from 'customer_2')`);
    await expect(financials.vendorBills.create({
      ...input, expenseLines: [assignedLine, { ...assignedLine, customerId: "customer_2" }]
    })).rejects.toThrow('violates check constraint "test_reject_customer"');
    expect(await counts()).toEqual(before);
    await pool.query('alter table erp_financials.subledger_document_lines drop constraint test_reject_customer');
    const original = await financials.vendorBills.create(input);
    const beforeReplacement = await counts();
    await expect(financials.vendorBills.replacePosted({
      operation: sdkOperation(), vendorBillId: original.documentId, expectedVersion: 1,
      idempotencyKey: "invalid-customer-replacement", date: "2026-08-12",
      replacement: { ...input, idempotencyKey: "invalid-customer-replacement-bill",
        expenseLines: [{ accountId: "account_cash", amount: "10.00", customerId: "vendor_1" }] }
    })).rejects.toMatchObject({ code: "missing_party" });
    expect(await counts()).toEqual(beforeReplacement);
    const state = await pool.query(`select status, version from erp_financials.subledger_documents
where subledger_document_id = $1`, [original.documentId]);
    expect(state.rows).toEqual([{ status: "open", version: 1 }]);
  });

  it("atomically clears ordered vendor bills, exposes provenance and summary, and compensates applications", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:bill-payment-disbursement" });
    await seedAccountingScope(pool);
    const operation = sdkOperation();
    const sdk = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_primary",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });
    await sdk.books.define({ operation, bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({
      operation,
      bookId: "book_primary",
      sourceId: "source_1",
      sourceRole: "active",
      effectiveFrom: "2026-01-01"
    });
    const firstBill = await sdk.commands.vendorBills.create({
      operation,
      idempotencyKey: "integration-disbursement-bill-1",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      vendorId: "vendor_1",
      payableAccount: { accountId: "account_ap" },
      expenseLines: [{ accountId: "account_cash", amount: "12.00" }]
    });
    const secondBill = await sdk.commands.vendorBills.create({
      operation,
      idempotencyKey: "integration-disbursement-bill-2",
      date: "2026-08-02",
      dueDate: "2026-08-31",
      vendorId: "vendor_1",
      payableAccount: { accountId: "account_ap" },
      expenseLines: [{ accountId: "account_cash", amount: "8.00" }]
    });
    const command = {
      operation,
      idempotencyKey: "integration-disbursement",
      date: "2026-08-10" as const,
      documentNumber: "PAY-200",
      vendorId: "vendor_1",
      amount: "20.00",
      paymentMethod: "ach" as const,
      reference: "ACH-200",
      payableAccount: { accountId: "account_ap" },
      cashAccount: { accountId: "account_cash" },
      allocations: [
        { billId: firstBill.documentId, amount: "12.00", expectedBillVersion: 1 },
        { billId: secondBill.documentId, amount: "8.00", expectedBillVersion: 1 }
      ]
    };
    const cleared = await sdk.commands.billPayments.recordAndApply(command);
    await expect(sdk.commands.billPayments.recordAndApply(command)).resolves.toMatchObject({
      status: "already_cleared",
      billPaymentId: cleared.billPaymentId
    });
    await expect(sdk.queries.getBillPayment(cleared.billPaymentId)).resolves.toMatchObject({
      status: "cleared",
      paymentMethod: "ach",
      reference: "ACH-200",
      fundingAccount: { accountId: "account_cash", creditAmount: "20.00" },
      payableAccount: { accountId: "account_ap", debitAmount: "20.00" },
      applications: [
        { targetDocumentId: firstBill.documentId, amount: "12.00" },
        { targetDocumentId: secondBill.documentId, amount: "8.00" }
      ]
    });
    await expect(sdk.queries.getBillPaymentSummary({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      status: "cleared"
    })).resolves.toMatchObject({ clearedAmount: "20.00", clearedCount: 1, totalAmount: "20.00", totalCount: 1 });

    const compensated = await sdk.commands.billPayments.voidAndUnapply({
      operation: { ...operation, requestId: "request:compensate-disbursement" },
      billPaymentId: cleared.billPaymentId,
      expectedVersion: 2,
      idempotencyKey: "integration-compensate-disbursement",
      date: "2026-08-12",
      memo: "Rejected ACH"
    });
    expect(compensated).toMatchObject({ status: "voided", disbursementVersion: 3 });
    await expect(sdk.queries.getVendorBill(firstBill.documentId)).resolves.toMatchObject({
      status: "open",
      openAmount: "12.00"
    });
    await expect(sdk.queries.getVendorBill(secondBill.documentId)).resolves.toMatchObject({
      status: "open",
      openAmount: "8.00"
    });
  });

  it.each([0, 16, 24])("retains inactive mapped account history and posting eligibility (from version=%s)", async (upgrade) => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:inactive", ...(upgrade ? { targetVersion: upgrade } : {}) });
    await seedAccountingScope(pool);
    const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_1", companyId: "company_1",
      bookId: "book_primary", writeSourceId: "source_1", currencyCode: "USD", postingPolicy: "legacy_unrestricted" });
    const operation = (requestId: string) => ({ ...sdkOperation(), requestId });
    await sdk.books.define({ operation: operation("book"), bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation: operation("source"), bookId: "book_primary", sourceId: "source_1", sourceRole: "active" });
    const definition = { bookId: "book_primary", bookAccountKey: "revenue", name: "Service Revenue",
      classification: "income" as const, accountRole: "posting" as const };
    const created = await sdk.books.defineAccount({ ...definition, operation: operation("create"), expectedVersion: 0 });
    const mappingInput = { operation: operation("map"), bookId: "book_primary", sourceId: "source_1",
      accountId: "account_income", bookAccountKey: "revenue" };
    const mapping = await sdk.books.mapAccount(mappingInput);
    const journal = { operation: operation("post"), idempotencyKey: "inactive-history", date: "2026-08-15",
      lines: [{ accountId: "account_cash", debit: "25.00" }, { accountId: "account_income", credit: "25.00" }] };
    const posted = await sdk.commands.journalEntries.post(journal);
    const filters = { periodStart: "2026-08-01", periodEnd: "2026-08-31" };
    const history = async () => ({
      profitAndLoss: await sdk.queries.getFinancialStatement({ ...filters, reportName: "profit_and_loss" }),
      balanceSheet: await sdk.queries.getFinancialStatement({ ...filters, reportName: "balance_sheet" }),
      trialBalance: await sdk.queries.getFinancialStatement({ ...filters, reportName: "trial_balance" }),
      ledger: await sdk.queries.listGeneralLedger(filters),
      summary: await sdk.queries.getGeneralLedgerSummary(filters),
      postings: (await pool.query('select * from erp_financials.ledger_postings order by posting_id')).rows,
      transactions: (await pool.query('select * from erp_financials.transactions order by transaction_id')).rows
    });
    const before = await history();
    if (upgrade) {
      await expect(sdk.books.defineAccount({ ...definition, operation: operation("old-deactivate"), active: false,
        expectedVersion: 1 })).rejects.toThrow("must remain an active posting account");
      const migrationHistory = await validatePostgresMigrationHistory(new PgQueryClient(pool));
      await expect(migratePostgresSchema({ transaction: work => runner.transaction(client =>
        work(new FailingMigrationClient(client, "insert into \"erp_financials\".\"schema_migrations\""))) },
      { appliedByRef: "integration:failed-inactive-upgrade" })).rejects.toThrow("injected real migration failure");
      expect(await validatePostgresMigrationHistory(new PgQueryClient(pool))).toEqual(migrationHistory);
      await expect(sdk.books.defineAccount({ ...definition, operation: operation("still-old"), active: false,
        expectedVersion: 1 })).rejects.toThrow("must remain an active posting account");
      const upgraded = await migratePostgresSchema(runner, { appliedByRef: "integration:inactive-upgrade" });
      expect(upgraded.currentVersion).toBe(upgrade);
      expect(upgraded.applied.at(-1)).toMatchObject({ fromVersion: 24, toVersion: 25 });
      expect(await history()).toEqual(before);
      expect((await migratePostgresSchema(runner, { appliedByRef: "integration:inactive-upgrade-replay" })).applied).toEqual([]);
    }
    const deactivate = { ...definition, operation: operation("deactivate"), active: false, expectedVersion: created.version };
    const inactive = await runner.transaction(async client => {
      const transactionalSdk = createErpFinancialsSdk({ database: { transaction: work => work(client) },
        tenantId: "tenant_1", companyId: "company_1", bookId: "book_primary", writeSourceId: "source_1", currencyCode: "USD" });
      const changed = await transactionalSdk.books.defineAccount(deactivate);
      const competingSdk = createErpFinancialsSdk({ database: { transaction: work => runner.transaction(async competitor => {
        await competitor.query("set local lock_timeout = '100ms'");
        return work(competitor);
      }) }, tenantId: "tenant_1", companyId: "company_1", bookId: "book_primary", writeSourceId: "source_1",
      currencyCode: "USD", postingPolicy: "legacy_unrestricted" });
      // A concurrent posting must wait for the lifecycle commit instead of using the old active state.
      await expect(competingSdk.commands.journalEntries.post({ ...journal, idempotencyKey: "concurrent" }))
        .rejects.toThrow("lock timeout");
      return changed;
    });
    expect(inactive).toMatchObject({ bookAccountId: created.bookAccountId, active: false, version: 2 });
    expect(await sdk.books.defineAccount(deactivate)).toEqual(inactive);
    for (const [assignment, message] of [
      ["account_role = 'header'", "must remain a posting account"],
      ["account_type = 'different'", "type cannot change"],
      ["classification = 'expense'", "classification must match"],
      ["book_account_key = 'redirected'", "identity is immutable"]
    ] as const) {
      await expect(pool.query(`update erp_financials.reporting_book_accounts set ${assignment}, version = version + 1
        where book_account_id = $1`, [created.bookAccountId])).rejects.toThrow(message);
    }
    await expect(sdk.books.defineAccount({ ...deactivate, active: true })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(sdk.books.defineAccount({ ...deactivate, operation: operation("stale") })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
    expect(await sdk.books.mapAccount(mappingInput)).toMatchObject({ bookAccountMappingId: mapping.bookAccountMappingId,
      accountId: mapping.accountId, bookAccountKey: mapping.bookAccountKey, createdAt: mapping.createdAt });
    expect(await history()).toEqual(before);
    expect(await sdk.queries.listChartOfAccounts({ asOfDate: "2026-08-31" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ bookAccountKey: "revenue", active: false, directBalance: "-25.00" })
    ]));
    const writeState = async () => Promise.all(["financial_lifecycle_events", "financial_outbox", "import_batches", "transaction_lines"]
      .map(async table => (await pool.query<Record<string, unknown>>(`select * from erp_financials.${table} order by 1`)).rows));
    const beforeDenied = await writeState();
    await expect(sdk.commands.journalEntries.post({ ...journal, operation: operation("denied"), idempotencyKey: "denied" }))
      .rejects.toThrow(/inactive/);
    expect(await history()).toEqual(before);
    expect(await writeState()).toEqual(beforeDenied);
    expect(await sdk.commands.journalEntries.post(journal)).toMatchObject({ transactionId: posted.transactionId, status: "already_posted" });
    const reactivate = { ...definition, operation: operation("reactivate"), active: true, expectedVersion: inactive.version };
    const active = await sdk.books.defineAccount(reactivate);
    expect(active).toMatchObject({ bookAccountId: created.bookAccountId, active: true, version: 3 });
    expect(await sdk.books.defineAccount(reactivate)).toEqual(active);
    // An old retry after a later transition cannot undo the later state.
    await expect(sdk.books.defineAccount(deactivate)).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
    // Source-account inactivity independently prevents posting even when the book account is active.
    const sourceDefinition = { accountId: "account_income", sourceAccountId: "income", name: "Service Revenue", classification: "income" as const };
    await sdk.commands.accounts.upsertTree({ operation: operation("source-off"), parent: { ...sourceDefinition, active: false } });
    await expect(sdk.commands.journalEntries.post({ ...journal, operation: operation("source-denied"), idempotencyKey: "source-denied" }))
      .rejects.toThrow(/inactive/);
    expect(await history()).toEqual(before);
    await sdk.commands.accounts.upsertTree({ operation: operation("source-on"), parent: { ...sourceDefinition, active: true } });
    await expect(sdk.commands.journalEntries.post({ ...journal, operation: operation("restored"), idempotencyKey: "restored" }))
      .resolves.toMatchObject({ status: "posted" });
    expect((await pool.query("select account_id, source_account_id from erp_financials.accounts where account_id = 'account_income'")).rows)
      .toEqual([{ account_id: "account_income", source_account_id: "income" }]);
  });

  it("creates inactive source and book accounts with retained mappings and rolls back the whole host transaction", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:inactive-create" });
    await seedAccountingScope(pool);
    const sdkFor = (database: PostgresMigrationTransactionRunner, tenantId = "tenant_1", companyId = "company_1") =>
      createErpFinancialsSdk({ database, tenantId, companyId, bookId: "book_primary", writeSourceId: "source_1",
        currencyCode: "USD", postingPolicy: "legacy_unrestricted" });
    const sdk = sdkFor(runner);
    const operation = sdkOperation();
    await sdk.books.define({ operation, bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: "book_primary", sourceId: "source_1", sourceRole: "active" });
    const mirror = async (database: PostgresMigrationTransactionRunner, classification: "income" | "expense" = "income") => {
      const scoped = sdkFor(database);
      const source = await scoped.commands.accounts.upsertTree({ operation,
        parent: { accountKey: "retired", name: "Retired", classification: "income", active: false } });
      const account = await scoped.books.defineAccount({ operation, bookId: "book_primary", bookAccountKey: "retired",
        name: "Retired", classification, accountRole: "posting", active: false, expectedVersion: 0 });
      const sourceAccount = source.accounts[0];
      if (sourceAccount === undefined) throw new Error("Missing created source account");
      const mapping = await scoped.books.mapAccount({ operation, bookId: "book_primary", sourceId: "source_1",
        accountId: sourceAccount.accountId, bookAccountKey: "retired" });
      return { source, account, mapping };
    };
    const state = async () => {
      const tables = ["accounts", "reporting_book_accounts", "reporting_book_account_mappings", "financial_lifecycle_events", "financial_outbox"];
      return Promise.all(tables.map(async table => (await pool.query<Record<string, unknown>>(`select * from erp_financials.${table} order by 1`)).rows));
    };
    const before = await state();
    await expect(runner.transaction(client => mirror({ transaction: work => work(client) }, "expense")))
      .rejects.toMatchObject({ code: "invalid_account_hierarchy" });
    expect(await state()).toEqual(before);
    await expect(runner.transaction(async client => {
      await mirror({ transaction: work => work(client) });
      throw new Error("injected host failure");
    })).rejects.toThrow("injected host failure");
    expect(await state()).toEqual(before);
    const created = await runner.transaction(client => mirror({ transaction: work => work(client) }));
    const canonicalAccount = created.source.accounts[0];
    if (canonicalAccount === undefined) throw new Error("Missing created source account");
    expect(canonicalAccount).toMatchObject({ active: false });
    expect(created.account).toMatchObject({ active: false, version: 1 });
    const repeated = await runner.transaction(client => mirror({ transaction: work => work(client) }));
    expect(repeated.account).toEqual(created.account);
    expect(repeated.source.accounts).toEqual(created.source.accounts);
    expect(repeated.mapping.bookAccountMappingId).toBe(created.mapping.bookAccountMappingId);
    const header = { operation: { ...operation, requestId: "header" }, bookId: "book_primary", bookAccountKey: "header",
      name: "Income", classification: "income" as const, accountRole: "header" as const, expectedVersion: 0 };
    await sdk.books.defineAccount(header);
    await sdk.books.defineAccount({ ...header, operation: { ...operation, requestId: "child" }, bookAccountKey: "child",
      name: "Child", accountRole: "posting", parentBookAccountKey: "header", active: false });
    await expect(sdk.books.defineAccount({ ...header, operation: { ...operation, requestId: "header-off" },
      active: false, expectedVersion: 1 })).rejects.toThrow("with children must remain an active header");
    await expect(sdk.books.mapAccount({ operation, bookId: "book_primary", sourceId: "source_1",
      accountId: canonicalAccount.accountId, bookAccountKey: "header" }))
      .rejects.toMatchObject({ code: "invalid_account_hierarchy" });
    const mappingInput = { operation, bookId: "book_primary", sourceId: "source_1",
      accountId: canonicalAccount.accountId, bookAccountKey: "retired" };
    expect(await sdk.books.mapAccount(mappingInput)).toMatchObject({ bookAccountMappingId: created.mapping.bookAccountMappingId });
    for (const other of [sdkFor(runner, "other_tenant"), sdkFor(runner, "tenant_1", "other_company")]) {
      await expect(other.books.mapAccount(mappingInput)).rejects.toMatchObject({ code: "scope_mismatch" });
    }
    await expect(sdk.books.mapAccount({ ...mappingInput, bookId: "other_book" })).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(sdk.books.mapAccount({ ...mappingInput, sourceId: "source_2" })).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(sdk.commands.journalEntries.post({ operation, idempotencyKey: "inactive-create-denied", date: "2026-08-15",
      lines: [{ accountId: "account_cash", debit: "1.00" }, { accountId: mappingInput.accountId, credit: "1.00" }] }))
      .rejects.toThrow(/inactive/);
  });

  it("blocks new cash-basis applications and refunds while inactive without breaking replay", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:inactive-cash" });
    await seedAccountingScope(pool);
    const sdk = createErpFinancialsSdk({ database: runner, tenantId: "tenant_1", companyId: "company_1",
      bookId: "book_primary", writeSourceId: "source_1", currencyCode: "USD", postingPolicy: "legacy_unrestricted" });
    const operation = sdkOperation();
    await sdk.books.define({ operation, bookId: "book_primary", name: "Primary", baseCurrencyCode: "USD" });
    await sdk.books.bindSource({ operation, bookId: "book_primary", sourceId: "source_1", sourceRole: "active" });
    const definition = { bookId: "book_primary", bookAccountKey: "revenue", name: "Service Revenue",
      classification: "income" as const, accountRole: "posting" as const };
    await sdk.books.defineAccount({ ...definition, operation, expectedVersion: 0 });
    await sdk.books.mapAccount({ operation, bookId: "book_primary", sourceId: "source_1",
      accountId: "account_income", bookAccountKey: "revenue" });
    const invoice = await sdk.commands.invoices.create({ operation, idempotencyKey: "cash-invoice", date: "2026-08-01",
      dueDate: "2026-08-31", customerId: "customer_1", receivableAccount: { accountId: "account_ar" },
      revenueLines: [{ accountId: "account_income", amount: "100.00" }] });
    const payment = await sdk.commands.customerPayments.record({ operation, idempotencyKey: "cash-payment", date: "2026-08-15",
      customerId: "customer_1", amount: "100.00", receivableAccount: { accountId: "account_ar" }, cashAccount: { accountId: "account_cash" } });
    const refund = { operation, idempotencyKey: "cash-refund", date: "2026-08-15", customerId: "customer_1", amount: "10.00",
      receivableAccount: { accountId: "account_ar" }, cashAccount: { accountId: "account_cash" }, relatedInvoiceId: invoice.documentId };
    await sdk.commands.refunds.issue(refund);
    const apply = { operation, idempotencyKey: "cash-application", applicationType: "customer_payment_to_invoice" as const,
      sourceDocumentId: payment.documentId, targetDocumentId: invoice.documentId, expectedSourceVersion: 1, expectedTargetVersion: 1,
      amount: "100.00", applicationDate: "2026-08-15" };
    await sdk.books.defineAccount({ ...definition, operation: { ...operation, requestId: "cash-off" }, active: false, expectedVersion: 1 });
    const state = async () => Promise.all(["transactions", "transaction_lines", "ledger_postings", "import_batches",
      "subledger_documents", "subledger_applications", "financial_lifecycle_events", "financial_outbox"]
      .map(async table => (await pool.query<Record<string, unknown>>(`select * from erp_financials.${table} order by 1`)).rows));
    const before = await state();
    await expect(sdk.commands.paymentApplications.apply(apply)).rejects.toThrow(/inactive/);
    expect(await state()).toEqual(before);
    await expect(sdk.commands.refunds.issue({ ...refund, idempotencyKey: "cash-refund-denied" })).rejects.toThrow(/inactive/);
    expect(await state()).toEqual(before);
    await expect(sdk.commands.refunds.issue(refund)).resolves.toMatchObject({ status: "already_posted" });
    expect(await state()).toEqual(before);
    await sdk.books.defineAccount({ ...definition, operation: { ...operation, requestId: "cash-on" }, active: true, expectedVersion: 2 });
    await expect(sdk.commands.paymentApplications.apply(apply)).resolves.toMatchObject({ status: "applied" });
    await sdk.books.defineAccount({ ...definition, operation: { ...operation, requestId: "cash-off-again" }, active: false, expectedVersion: 3 });
    const applied = await state();
    await expect(sdk.commands.paymentApplications.apply(apply)).resolves.toMatchObject({ status: "already_applied" });
    expect(await state()).toEqual(applied);
  });

  it("uses the scoped transaction identity index for an important journal lookup", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:query-plan" });
    await seedAccountingScope(pool);
    const client = await pool.connect();
    try {
      await client.query("set enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `explain select * from erp_financials.transactions
where tenant_id = 'tenant_1' and source_id = 'source_1' and transaction_id = 'journal_1'`
      );
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("transactions_scope_uidx");
    } finally {
      client.release();
    }
  });

  it("runs the host-facing SDK from book setup through invoice, atomic match, reconciliation, reads, and outbox delivery", async () => {
    await migratePostgresSchema(runner, { appliedByRef: "integration:sdk-v1" });
    await seedAccountingScope(pool);
    const operation = sdkOperation();
    const sdk = createErpFinancialsSdk({
      database: runner,
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_primary",
      writeSourceId: "source_1",
      currencyCode: "USD",
      postingPolicy: "legacy_unrestricted",
      now: () => "2026-08-12T12:00:00.000Z"
    });

    await sdk.books.define({
      operation,
      bookId: "book_primary",
      name: "Primary",
      baseCurrencyCode: "USD"
    });
    await sdk.books.bindSource({
      operation,
      bookId: "book_primary",
      sourceId: "source_1",
      sourceRole: "active",
      effectiveFrom: "2026-01-01"
    });
    for (const account of [
      {
        bookAccountKey: "income", accountNumber: "4000", name: "Income", classification: "income" as const,
        accountRole: "header" as const
      },
      {
        bookAccountKey: "service_revenue",
        accountNumber: "4010",
        name: "Service Revenue",
        classification: "income" as const,
        accountRole: "posting" as const,
        parentBookAccountKey: "income"
      }
    ]) {
      await sdk.books.defineAccount({ operation, bookId: "book_primary", expectedVersion: 0, ...account });
    }
    await sdk.books.mapAccount({
      operation,
      bookId: "book_primary",
      sourceId: "source_1",
      accountId: "account_income",
      bookAccountKey: "service_revenue"
    });
    await expect(sdk.books.defineAccount({
      operation: { ...operation, requestId: "account-income-deactivate", correlationId: "account-income-deactivate" },
      bookId: "book_primary",
      bookAccountKey: "income",
      accountNumber: "4000",
      name: "Income",
      classification: "income",
      accountRole: "header",
      active: false,
      expectedVersion: 1
    })).rejects.toThrow("a reporting-book account with children must remain an active header account");
    await expect(sdk.books.defineAccount({
      operation: { ...operation, requestId: "account-service-role", correlationId: "account-service-role" },
      bookId: "book_primary",
      bookAccountKey: "service_revenue",
      accountNumber: "4010",
      name: "Service Revenue",
      classification: "income",
      accountRole: "header",
      parentBookAccountKey: "income",
      expectedVersion: 1
    })).rejects.toThrow("a mapped reporting-book account must remain a posting account");
    await expect(sdk.books.defineAccount({
      operation: { ...operation, requestId: "account-number-duplicate", correlationId: "account-number-duplicate" },
      bookId: "book_primary",
      bookAccountKey: "duplicate_revenue",
      accountNumber: "4010",
      name: "Duplicate Revenue",
      classification: "income",
      accountRole: "posting",
      expectedVersion: 0
    })).rejects.toMatchObject({ code: "invalid_input" });
    const renamedAccountInput = {
      operation: { ...operation, requestId: "account-service-rename", correlationId: "account-service-rename" },
      bookId: "book_primary",
      bookAccountKey: "service_revenue",
      accountNumber: "4010",
      name: "Consulting Revenue",
      classification: "income" as const,
      accountRole: "posting" as const,
      parentBookAccountKey: "income",
      expectedVersion: 1
    };
    await expect(sdk.books.defineAccount(renamedAccountInput)).resolves.toMatchObject({
      name: "Consulting Revenue",
      version: 2
    });
    await expect(sdk.books.defineAccount(renamedAccountInput)).resolves.toMatchObject({
      name: "Consulting Revenue",
      version: 2
    });

    const draft = await sdk.invoices.createDraft({
      operation,
      idempotencyKey: "draft-1001",
      customerId: "customer_1",
      receivableAccount: { accountId: "account_ar" },
      documentNumber: "INV-1001",
      documentDate: "2026-08-01",
      dueDate: "2026-08-31",
      revenueLines: [{
        accountId: "account_income",
        amount: "25.00",
        quantity: "2.5",
        unitAmount: "10.00"
      }]
    });
    const issued = await sdk.invoices.issue({
      operation,
      invoiceDraftId: draft.invoiceDraftId,
      expectedVersion: draft.version,
      idempotencyKey: "invoice-1001"
    });
    const payment = await sdk.commands.customerPayments.record({
      operation,
      idempotencyKey: "payment-1001",
      date: "2026-08-05",
      customerId: "customer_1",
      amount: "25.00",
      cashAccount: { accountId: "account_cash" },
      receivableAccount: { accountId: "account_ar" }
    });
    await pool.query(
      `insert into erp_financials.transaction_match_candidates (
  match_candidate_id, tenant_id, source_id, match_kind, origin_transaction_id, target_transaction_id,
  matcher_version, score, suggested_application_amount, currency_code, status, evidence, created_at, expires_at
) values ($1, 'tenant_1', 'source_1', 'customer_payment_to_invoice', $2, $3, 'integration-v1', 1, 25, 'USD',
  'suggested', '[{"criterion":"party","matched":true,"weight":"1","score":"1"}]'::jsonb,
  '2026-08-06T00:00:00Z', '2026-09-01T00:00:00Z')`,
      ["candidate_sdk_1", payment.journal.transactionId, issued.transactionId]
    );
    const applied = await sdk.paymentMatching.acceptAndApply({
      operation,
      matchCandidateId: "candidate_sdk_1",
      sourceDocumentId: payment.documentId,
      targetDocumentId: issued.invoiceDocumentId,
      amount: "25.00",
      applicationDate: "2026-08-06",
      expectedSourceVersion: payment.version,
      expectedTargetVersion: 1,
      idempotencyKey: "apply-1001",
      method: "manual"
    });
    expect(applied.application).toMatchObject({ status: "applied", appliedAmount: "25.00" });

    const bankLine = await sdk.bankReconciliation.ingest({
      operation,
      externalLineId: "bank-line-1001",
      bankAccountId: "account_cash",
      postedDate: "2026-08-05",
      amount: "25.00"
    });
    await expect(sdk.bankReconciliation.match({
      operation,
      bankStatementLineId: bankLine.bankStatementLineId,
      transactionId: payment.journal.transactionId,
      expectedVersion: bankLine.version,
      idempotencyKey: "bank-match-1001",
      method: "manual"
    })).resolves.toMatchObject({ status: "matched", matchedAmount: "25.00" });
    const reloadedMatchedPage = await sdk.queries.listBankReconciliation({ status: "matched", limit: 25 });
    const reloadedMatchedLine = reloadedMatchedPage.items.find(
      (line) => line.bankStatementLineId === bankLine.bankStatementLineId
    );
    expect(reloadedMatchedLine).toMatchObject({
      status: "matched",
      bankReconciliationMatchVersion: 1,
      matchedTransactionId: payment.journal.transactionId,
      matchMethod: "manual",
      version: 2
    });
    if (reloadedMatchedLine === undefined || reloadedMatchedLine.status !== "matched") {
      throw new Error("Expected the matched line to reload with durable match evidence");
    }

    const invoice = await sdk.queries.getInvoice(issued.invoiceDocumentId, "2026-08-12");
    expect(invoice).toMatchObject({ status: "paid", openAmount: "0.00", originalAmount: "25.00" });
    expect(invoice.lines).toEqual([expect.objectContaining({ quantity: "2.5", unitAmount: "10.00", amount: "25.00" })]);
    await expect(sdk.queries.getInvoiceSummary({ asOfDate: "2026-08-12" })).resolves.toMatchObject({
      outstandingAmount: "0.00",
      outstandingInvoiceCount: 0,
      unsentDraftCount: 0,
      collectedAmount: "25.00",
      settledInvoiceCount: 1
    });
    await expect(sdk.queries.getPaymentSummary({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31"
    })).resolves.toMatchObject({
      receivedAmount: "25.00",
      receivedPaymentCount: 1,
      matchedPaymentCount: 1,
      automaticallyMatchedPaymentCount: 0,
      automaticMatchRatePercent: "0.00",
      unappliedAmount: "0.00",
      awaitingBankReviewCount: 0
    });
    await expect(sdk.queries.getGeneralLedgerSummary({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31"
    })).resolves.toMatchObject({
      postingCount: 4,
      totalDebits: "50.00",
      totalCredits: "50.00",
      difference: "0.00"
    });
    const ledgerFilters = {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accountKey: "service_revenue",
      sourceId: "source_1",
      transactionType: "Subledger:invoice",
      polarity: "credit" as const,
      search: "INV-1001"
    };
    await expect(sdk.queries.listGeneralLedger({ ...ledgerFilters, limit: 25 })).resolves.toMatchObject({
      items: [{
        transactionType: "Subledger:invoice",
        bookAccountKey: "service_revenue",
        creditAmount: "25.00",
        sourceProvenance: {
          sourceId: "source_1",
          sourceRole: "active",
          sourceSystem: "native_erp",
          sourceTransactionType: "Subledger:invoice"
        }
      }]
    });
    await expect(sdk.queries.getGeneralLedgerSummary(ledgerFilters)).resolves.toMatchObject({
      postingCount: 1,
      totalDebits: "0.00",
      totalCredits: "25.00",
      difference: "-25.00"
    });
    const statement = await sdk.queries.getFinancialStatement({
      reportName: "profit_and_loss",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31"
    });
    expect(statement.lines).toEqual([
      expect.objectContaining({ bookAccountKey: "income", directAmount: "0.00", amount: "25.00" }),
      expect.objectContaining({ bookAccountKey: "service_revenue", directAmount: "25.00", amount: "25.00" })
    ]);
    await expect(sdk.queries.getBankReconciliationSummary()).resolves.toMatchObject({ matchedCount: 1 });

    const staleMatchEvidence = await reconciliationEvidenceCounts(
      pool,
      reloadedMatchedLine.bankReconciliationMatchId,
      "bank_reconciliation.unmatched"
    );
    await expect(sdk.bankReconciliation.unmatch({
      operation: { ...operation, requestId: "request:stale-bank-unmatch" },
      bankReconciliationMatchId: reloadedMatchedLine.bankReconciliationMatchId,
      expectedVersion: reloadedMatchedLine.bankReconciliationMatchVersion + 1
    })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
    await expect(reconciliationEvidenceCounts(
      pool,
      reloadedMatchedLine.bankReconciliationMatchId,
      "bank_reconciliation.unmatched"
    )).resolves.toEqual(staleMatchEvidence);

    await expect(sdk.bankReconciliation.unmatch({
      operation: { ...operation, requestId: "request:bank-unmatch" },
      bankReconciliationMatchId: reloadedMatchedLine.bankReconciliationMatchId,
      expectedVersion: reloadedMatchedLine.bankReconciliationMatchVersion
    })).resolves.toMatchObject({ status: "unmatched", version: 2 });
    const reloadedUnmatchedPage = await sdk.queries.listBankReconciliation({ status: "unmatched", limit: 25 });
    const reloadedUnmatchedLine = reloadedUnmatchedPage.items.find(
      (line) => line.bankStatementLineId === bankLine.bankStatementLineId
    );
    expect(reloadedUnmatchedLine).toMatchObject({ status: "unmatched", version: 3 });
    if (reloadedUnmatchedLine === undefined) throw new Error("Expected the unmatched bank line to reload");

    await expect(sdk.bankReconciliation.ignore({
      operation: { ...operation, requestId: "request:bank-ignore" },
      bankStatementLineId: reloadedUnmatchedLine.bankStatementLineId,
      expectedVersion: reloadedUnmatchedLine.version
    })).resolves.toMatchObject({ status: "ignored", version: 4 });
    const reloadedIgnoredPage = await sdk.queries.listBankReconciliation({ status: "ignored", limit: 25 });
    const reloadedIgnoredLine = reloadedIgnoredPage.items.find(
      (line) => line.bankStatementLineId === bankLine.bankStatementLineId
    );
    expect(reloadedIgnoredLine).toMatchObject({ status: "ignored", version: 4 });
    if (reloadedIgnoredLine === undefined) throw new Error("Expected the ignored bank line to reload");

    const reopenOperation = {
      ...operation,
      requestId: "request:bank-unignore",
      correlationId: "correlation:bank-correction",
      reasonCode: "bank_line_ignored_in_error",
      reasonDetail: "Controller approved reopening the incorrectly ignored bank statement line"
    } as const;
    const beforeRejectedReopen = await reconciliationEvidenceCounts(
      pool,
      reloadedIgnoredLine.bankStatementLineId,
      "bank_statement_line.unignored"
    );
    const { approverRef: omittedApproverRef, ...missingApproverOperation } = reopenOperation;
    const { reasonDetail: omittedReasonDetail, ...missingReasonDetailOperation } = reopenOperation;
    void omittedApproverRef;
    void omittedReasonDetail;
    await expect(sdk.bankReconciliation.unignore({
      operation: { ...reopenOperation, requestId: "request:stale-bank-unignore" },
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version - 1
    })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });
    await expect(sdk.bankReconciliation.unignore({
      operation: { ...missingApproverOperation, requestId: "request:missing-approver" },
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    await expect(sdk.bankReconciliation.unignore({
      operation: { ...reopenOperation, requestId: "request:missing-actor", actorRef: "" },
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    await expect(sdk.bankReconciliation.unignore({
      operation: { ...missingReasonDetailOperation, requestId: "request:missing-reason-detail" },
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    await expect(sdk.bankReconciliation.unignore({
      operation: { ...reopenOperation, requestId: "request:self-approved", approverRef: reopenOperation.actorRef },
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    })).rejects.toMatchObject({ code: "authorization_context_invalid" });
    await expect(reconciliationEvidenceCounts(
      pool,
      reloadedIgnoredLine.bankStatementLineId,
      "bank_statement_line.unignored"
    )).resolves.toEqual(beforeRejectedReopen);

    const reopened = await sdk.bankReconciliation.unignore({
      operation: reopenOperation,
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    });
    expect(reopened).toMatchObject({ status: "unmatched", version: 5 });
    await expect(sdk.queries.listBankReconciliation({ status: "unmatched", limit: 25 })).resolves.toMatchObject({
      items: [expect.objectContaining({
        bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
        status: "unmatched",
        version: 5
      })]
    });
    const firstReopenEvidence = await reconciliationEvidenceCounts(
      pool,
      reloadedIgnoredLine.bankStatementLineId,
      "bank_statement_line.unignored"
    );
    expect(firstReopenEvidence).toEqual({ auditCount: 1, outboxCount: 1 });
    await expect(sdk.bankReconciliation.unignore({
      operation: reopenOperation,
      bankStatementLineId: reloadedIgnoredLine.bankStatementLineId,
      expectedVersion: reloadedIgnoredLine.version
    })).resolves.toEqual(reopened);
    await expect(reconciliationEvidenceCounts(
      pool,
      reloadedIgnoredLine.bankStatementLineId,
      "bank_statement_line.unignored"
    )).resolves.toEqual(firstReopenEvidence);
    await expect(pool.query(
      `select actor_ref, approver_ref, request_id, correlation_id, reason_code, reason_detail, occurred_at
from erp_financials.financial_lifecycle_events
where aggregate_id = $1 and event_type = 'bank_statement_line.unignored'`,
      [reloadedIgnoredLine.bankStatementLineId]
    )).resolves.toMatchObject({
      rows: [{
        actor_ref: reopenOperation.actorRef,
        approver_ref: reopenOperation.approverRef,
        request_id: reopenOperation.requestId,
        correlation_id: reopenOperation.correlationId,
        reason_code: reopenOperation.reasonCode,
        reason_detail: reopenOperation.reasonDetail,
        occurred_at: new Date(reopenOperation.occurredAt)
      }]
    });

    const delivered: string[] = [];
    const runtimeResult = await sdk.createRuntime({
      onEvent: (event) => {
        delivered.push(event.outboxEventId);
        return Promise.resolve();
      }
    }).runOnce({ limit: 500 });
    expect(runtimeResult).toMatchObject({ claimed: delivered.length, published: delivered.length, failed: 0 });
    expect(delivered.length).toBeGreaterThan(0);
  });
});

class PgQueryClient implements PostgresQueryClient {
  constructor(private readonly queryable: Pick<Pool | PoolClient, "query">) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.queryable.query<QueryResultRow>(sql, [...params]);
    return { rows: result.rows as unknown as readonly Row[], rowCount: result.rowCount };
  }
}

class PgTransactionRunner implements PostgresMigrationTransactionRunner {
  constructor(private readonly pool: Pool) {}

  async transaction<Result>(work: (client: PostgresQueryClient) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await work(new PgQueryClient(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

class FailingMigrationClient implements PostgresQueryClient {
  constructor(
    private readonly client: PostgresQueryClient,
    private readonly failingSqlFragment: string
  ) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes(this.failingSqlFragment)) {
      return Promise.reject(new Error("injected real migration failure"));
    }
    return this.client.query<Row>(sql, params);
  }
}

function requiredSafeTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined) {
    return "postgres://unused:unused@127.0.0.1:1/erp_financials_test_skipped";
  }
  const parsed = new URL(value);
  const databaseName = parsed.pathname.slice(1);
  if (!/^erp_financials(?:_|-)test(?:_|-|$)/u.test(databaseName)) {
    throw new Error("ERP_FINANCIALS_TEST_DATABASE_URL must target a database named erp_financials_test*");
  }
  return value;
}

async function snapshotScopeColumns(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
where table_schema = 'erp_financials' and table_name = 'report_snapshots'
  and column_name in ('company_id', 'source_id') order by column_name`
  );
  return result.rows.map((row) => row.column_name);
}

async function seedQuickBooksImportScope(pool: Pool): Promise<void> {
  await pool.query(`
insert into erp_financials.accounting_companies values
  ('company_qbo', 'tenant_qbo', 'Spartan', 'Spartan', 'USD', 1, 'sandbox', 'quickbooks', 'realm_qbo');
insert into erp_financials.accounting_sources (
  source_id, tenant_id, source_system, provider_environment, connection_ref,
  import_batch_id, checkpoint_id, latest_synced_at, status
) values (
  'source_qbo', 'tenant_qbo', 'quickbooks', 'sandbox', 'connection:qbo',
  'batch_qbo', 'checkpoint_qbo', '2026-08-10T10:00:00Z', 'active'
);
insert into erp_financials.company_sources values
  ('company_source_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', '2026-08-10T10:00:00Z');
insert into erp_financials.import_batches (
  import_batch_id, tenant_id, source_id, mode, status, started_at, completed_at, source_object_counts
) values (
  'batch_qbo', 'tenant_qbo', 'source_qbo', 'initial', 'completed',
  '2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z', '{}'::jsonb
);
insert into erp_financials.sync_checkpoints (
  checkpoint_id, tenant_id, source_id, source_object, cursor_kind, cursor_value,
  fresh_through, latest_source_updated_at, status
) values (
  'checkpoint_qbo', 'tenant_qbo', 'source_qbo', 'quickbooks_full_sync', 'full_scan', 'full:realm_qbo',
  '2026-08-10T10:00:00Z', '2026-08-10T10:00:00Z', 'current'
);
insert into erp_financials.accounts (
  account_id, tenant_id, source_id, source_account_id, name, type, classification, active
) values
  ('account_cash_qbo', 'tenant_qbo', 'source_qbo', 'cash', 'Cash', 'Bank', 'asset', true),
  ('account_revenue_qbo', 'tenant_qbo', 'source_qbo', 'revenue', 'Revenue', 'Income', 'income', true);
insert into erp_financials.parties (
  party_id, tenant_id, source_id, source_party_id, party_type, display_name, active
) values ('customer_qbo', 'tenant_qbo', 'source_qbo', 'customer_20', 'customer', 'Acme', true);
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type,
  transaction_number, transaction_date, posted_at, updated_at, party_id, currency_code, status,
  source_payload_ref
) values
  ('transaction_invoice_qbo', 'tenant_qbo', 'source_qbo', 'invoice_600', 'Invoice', 'INV-600',
    '2026-08-01', '2026-08-01T12:00:00Z', '2026-08-10T10:00:00Z', 'customer_qbo', 'USD', 'posted', '{}'::jsonb),
  ('transaction_payment_qbo', 'tenant_qbo', 'source_qbo', 'payment_700', 'Payment', 'PMT-700',
    '2026-08-10', '2026-08-10T12:00:00Z', '2026-08-10T10:00:00Z', 'customer_qbo', 'USD', 'posted', '{}'::jsonb);
`);
}

async function seedSourceImportResetScenario(pool: Pool, runner: PgTransactionRunner): Promise<void> {
  await seedQuickBooksImportScope(pool);
  await pool.query(`
insert into erp_financials.items (
  item_id, tenant_id, source_id, source_item_id, item_type, name, active
) values ('item_qbo', 'tenant_qbo', 'source_qbo', 'item:1', 'service', 'Consulting', true);
insert into erp_financials.accounting_dimensions (
  dimension_id, tenant_id, source_id, dimension_kind, source_dimension_id, name, active
) values ('dimension_qbo', 'tenant_qbo', 'source_qbo', 'class', 'class:1', 'Services', true);
insert into erp_financials.transaction_lines (
  transaction_line_id, tenant_id, source_id, transaction_id, line_number, account_id, party_id,
  amount, dimension_refs
) values
  ('line_invoice_qbo', 'tenant_qbo', 'source_qbo', 'transaction_invoice_qbo', 1,
    'account_revenue_qbo', 'customer_qbo', 100, '[]'::jsonb),
  ('line_payment_qbo', 'tenant_qbo', 'source_qbo', 'transaction_payment_qbo', 1,
    'account_cash_qbo', 'customer_qbo', 40, '[]'::jsonb);
insert into erp_financials.ledger_postings (
  posting_id, tenant_id, source_id, source_posting_id, transaction_id, transaction_line_id,
  account_id, party_id, posting_date, accounting_basis, debit_amount, credit_amount, net_amount,
  currency_code, dimension_hash, dimension_refs, source_payload_ref, import_batch_id, checkpoint_id
) values
  ('posting_invoice_qbo', 'tenant_qbo', 'source_qbo', 'posting:invoice', 'transaction_invoice_qbo',
    'line_invoice_qbo', 'account_revenue_qbo', 'customer_qbo', '2026-08-01', 'accrual', 0, 100, -100,
    'USD', repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'batch_qbo', 'checkpoint_qbo'),
  ('posting_payment_qbo', 'tenant_qbo', 'source_qbo', 'posting:payment', 'transaction_payment_qbo',
    'line_payment_qbo', 'account_cash_qbo', 'customer_qbo', '2026-08-10', 'accrual', 40, 0, 40,
    'USD', repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'batch_qbo', 'checkpoint_qbo');
insert into erp_financials.rollup_buckets (
  rollup_bucket_id, tenant_id, company_id, source_id, account_id, accounting_basis,
  bucket_grain, bucket_start, bucket_end, currency_code, dimension_hash, party_id, party_type,
  item_id, debit_amount, credit_amount, net_amount, posting_count,
  source_posting_max_updated_at, import_batch_id, generated_at
) values ('rollup_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', 'account_cash_qbo', 'accrual',
  'month', '2026-08-01', '2026-08-31', 'USD', repeat('a', 64), '', '', '', 40, 0, 40, 1,
  '2026-08-10T10:00:00Z', 'batch_qbo', '2026-08-10T10:01:00Z');
insert into erp_financials.report_freshness (
  freshness_id, tenant_id, company_id, source_id, report_name, accounting_basis,
  period_start, period_end, currency_code, status, fresh_through, import_batch_id, checkpoint_id, updated_at
) values ('freshness_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', 'profit_and_loss', 'accrual',
  '2026-08-01', '2026-08-31', 'USD', 'fresh', '2026-08-10T10:00:00Z', 'batch_qbo',
  'checkpoint_qbo', '2026-08-10T10:01:00Z');
insert into erp_financials.report_snapshots (
  report_snapshot_id, tenant_id, company_id, source_id, report_name, snapshot_source,
  accounting_basis, period_start, period_end, as_of_date, currency_code, generated_at,
  freshness, reconciliation_status, reconciliation_difference
) values ('snapshot_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', 'profit_and_loss', 'rollup',
  'accrual', '2026-08-01', '2026-08-31', '2026-08-31', 'USD', '2026-08-10T10:01:00Z',
  '{"status":"fresh","sourceId":"source_qbo"}'::jsonb, 'reconciled', 0);
insert into erp_financials.report_snapshot_lines (
  report_line_id, tenant_id, company_id, source_id, report_snapshot_id, section, label,
  account_id, amount, sort_order, drilldown_ref
) values ('snapshot_line_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', 'snapshot_qbo',
  'income', 'Revenue', 'account_revenue_qbo', 100, 1, '{}'::jsonb);
insert into erp_financials.report_snapshot_totals (
  report_total_id, tenant_id, company_id, source_id, report_snapshot_id, total_key, label,
  amount, drilldown_ref
) values ('snapshot_total_qbo', 'tenant_qbo', 'company_qbo', 'source_qbo', 'snapshot_qbo',
  'net_income', 'Net income', 100, '{}'::jsonb);

insert into erp_financials.accounting_sources (
  source_id, tenant_id, source_system, provider_environment, connection_ref, status
) values
  ('source_qbo_other', 'tenant_qbo', 'quickbooks', 'sandbox', 'connection:qbo:other', 'active'),
  ('source_native', 'tenant_qbo', 'native_erp', 'native', 'native:spartan', 'active');
insert into erp_financials.company_sources values
  ('company_source_qbo_other', 'tenant_qbo', 'company_qbo', 'source_qbo_other', now()),
  ('company_source_native', 'tenant_qbo', 'company_qbo', 'source_native', now());
insert into erp_financials.accounts (
  account_id, tenant_id, source_id, source_account_id, name, type, classification, active
) values
  ('account_qbo_other', 'tenant_qbo', 'source_qbo_other', 'cash', 'Other cash', 'Bank', 'asset', true),
  ('account_native', 'tenant_qbo', 'source_native', 'cash', 'Native cash', 'Bank', 'asset', true);
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type,
  transaction_date, currency_code, status, source_payload_ref
) values
  ('transaction_qbo_other', 'tenant_qbo', 'source_qbo_other', 'other:1', 'Deposit',
    '2026-08-01', 'USD', 'posted', '{}'::jsonb),
  ('transaction_native', 'tenant_qbo', 'source_native', 'native:1', 'JournalEntry',
    '2026-09-01', 'USD', 'posted', '{}'::jsonb);

insert into erp_financials.reporting_books (
  tenant_id, company_id, book_id, name, base_currency_code, accounting_basis, status, created_at, updated_at
) values ('tenant_qbo', 'company_qbo', 'book_qbo', 'Spartan reporting', 'USD', 'accrual', 'active', now(), now());
insert into erp_financials.reporting_book_sources (
  book_source_id, tenant_id, company_id, book_id, source_id, source_role, effective_through, created_at
) values ('book_source_qbo', 'tenant_qbo', 'company_qbo', 'book_qbo', 'source_qbo', 'historical', '2026-08-31', now());
insert into erp_financials.reporting_book_accounts (
  book_account_id, tenant_id, company_id, book_id, book_account_key, account_number, name,
  classification, account_type, account_role, currency_code, active, version,
  last_operation_request_id, last_operation_checksum, created_at, updated_at
) values ('book_account_cash', 'tenant_qbo', 'company_qbo', 'book_qbo', 'cash', '1000', 'Cash',
  'asset', 'Bank', 'posting', 'USD', true, 1, 'seed:reset', repeat('a', 64), now(), now());
insert into erp_financials.reporting_book_account_mappings (
  book_account_mapping_id, tenant_id, company_id, book_id, source_id, account_id,
  book_account_key, created_at, updated_at
) values ('mapping_qbo_cash', 'tenant_qbo', 'company_qbo', 'book_qbo', 'source_qbo',
  'account_cash_qbo', 'cash', now(), now());
`);

  await runner.transaction((client) => persistQuickBooksSubledgerResources({
    client,
    companyId: "company_qbo",
    importedAt: "2026-08-10T10:01:00.000Z",
    facts: quickBooksSubledgerFacts(),
    resources: quickBooksSubledgerResources("40.00", true, "2026-08-10T10:00:00.000Z")
  }));
}

async function sourceResetState(pool: Pool): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(`
select
  ((select count(*) from erp_financials.transactions where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.subledger_documents where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.ledger_postings where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.report_snapshots where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.import_batches where tenant_id = 'tenant_qbo' and source_id = 'source_qbo'))::text as "selectedRuntimeRows",
  ((select count(*) from erp_financials.accounts where tenant_id = 'tenant_qbo' and source_id = 'source_qbo' and active)
    + (select count(*) from erp_financials.parties where tenant_id = 'tenant_qbo' and source_id = 'source_qbo' and active)
    + (select count(*) from erp_financials.items where tenant_id = 'tenant_qbo' and source_id = 'source_qbo' and active)
    + (select count(*) from erp_financials.accounting_dimensions where tenant_id = 'tenant_qbo' and source_id = 'source_qbo' and active))::text as "selectedActiveMasterRows",
  ((select count(*) from erp_financials.accounting_companies where tenant_id = 'tenant_qbo' and company_id = 'company_qbo')
    + (select count(*) from erp_financials.accounting_sources where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.company_sources where tenant_id = 'tenant_qbo' and company_id = 'company_qbo' and source_id = 'source_qbo'))::text as "selectedIdentityRows",
  ((select count(*) from erp_financials.reporting_books where tenant_id = 'tenant_qbo' and company_id = 'company_qbo')
    + (select count(*) from erp_financials.reporting_book_sources where tenant_id = 'tenant_qbo' and source_id = 'source_qbo')
    + (select count(*) from erp_financials.reporting_book_accounts where tenant_id = 'tenant_qbo' and company_id = 'company_qbo')
    + (select count(*) from erp_financials.reporting_book_account_mappings where tenant_id = 'tenant_qbo' and source_id = 'source_qbo'))::text as "reportingConfigurationRows",
  ((select count(*) from erp_financials.accounting_sources where source_id = 'source_qbo_other')
    + (select count(*) from erp_financials.company_sources where source_id = 'source_qbo_other')
    + (select count(*) from erp_financials.accounts where source_id = 'source_qbo_other')
    + (select count(*) from erp_financials.transactions where source_id = 'source_qbo_other'))::text as "otherSourceRows",
  ((select count(*) from erp_financials.accounting_sources where source_id = 'source_native')
    + (select count(*) from erp_financials.company_sources where source_id = 'source_native')
    + (select count(*) from erp_financials.accounts where source_id = 'source_native')
    + (select count(*) from erp_financials.transactions where source_id = 'source_native'))::text as "nativeSourceRows",
  (select status from erp_financials.accounting_sources where tenant_id = 'tenant_qbo' and source_id = 'source_qbo') as "selectedStatus"
`);
  const row = result.rows[0];
  if (row === undefined) throw new Error("source reset state query returned no row");
  return row;
}

function quickBooksSubledgerFacts(): CanonicalAccountingFactSet {
  return {
    company: {
      companyId: "company_qbo", tenantId: "tenant_qbo", legalName: "Spartan", displayName: "Spartan",
      baseCurrencyCode: "USD", fiscalYearStartMonth: 1, providerEnvironment: "sandbox",
      sourceSystem: "quickbooks", sourceCompanyRef: "realm_qbo"
    },
    source: {
      tenantId: "tenant_qbo", sourceId: "source_qbo", sourceSystem: "quickbooks",
      providerEnvironment: "sandbox", connectionRef: "connection:qbo", importBatchId: "batch_qbo",
      checkpointId: "checkpoint_qbo", latestSyncedAt: "2026-08-10T10:00:00.000Z", status: "active"
    },
    importBatch: {
      tenantId: "tenant_qbo", sourceId: "source_qbo", importBatchId: "batch_qbo", mode: "initial",
      status: "completed", startedAt: "2026-08-10T09:00:00.000Z",
      completedAt: "2026-08-10T10:00:00.000Z", sourceObjectCounts: {}
    },
    checkpoint: {
      tenantId: "tenant_qbo", sourceId: "source_qbo", checkpointId: "checkpoint_qbo",
      sourceObject: "quickbooks_full_sync", cursorKind: "full_scan", cursorValue: "full:realm_qbo",
      freshThrough: "2026-08-10T10:00:00.000Z", latestSourceUpdatedAt: "2026-08-10T10:00:00.000Z",
      status: "current"
    },
    accounts: [
      { accountId: "account_cash_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourceAccountId: "cash", name: "Cash", type: "Bank", classification: "asset", active: true },
      { accountId: "account_revenue_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourceAccountId: "revenue", name: "Revenue", type: "Income", classification: "income", active: true }
    ],
    parties: [
      { partyId: "customer_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourcePartyId: "customer_20", partyType: "customer", displayName: "Acme", active: true }
    ],
    items: [],
    dimensions: [],
    transactions: [
      { transactionId: "transaction_invoice_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice", transactionNumber: "INV-600", transactionDate: "2026-08-01", partyId: "customer_qbo", currencyCode: "USD", status: "posted" },
      { transactionId: "transaction_payment_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourceTransactionId: "payment_700", sourceTransactionType: "Payment", transactionNumber: "PMT-700", transactionDate: "2026-08-10", partyId: "customer_qbo", currencyCode: "USD", status: "posted" }
    ],
    transactionLines: [],
    postings: []
  };
}

function quickBooksSubledgerResources(
  paymentAmount: string,
  linked: boolean,
  sourceUpdatedAt: string
): HandrailQuickBooksSdkResourceSet {
  const envelope = {
    sourceSystem: "quickbooks" as const,
    tenantId: "tenant_qbo",
    sourceId: "source_qbo",
    providerEnvironment: "sandbox" as const,
    realmId: "realm_qbo",
    importBatchId: "batch_qbo",
    checkpointId: "checkpoint_qbo",
    sourceUpdatedAt
  };
  return {
    companyInfo: {
      ...envelope, resourceType: "CompanyInfo", resourceId: "realm_qbo",
      resource: { CompanyName: "Spartan", LegalName: "Spartan" }
    },
    accounts: [],
    journalEntries: [],
    operationalDocuments: [
      {
        ...envelope, resourceType: "LedgerTransaction", resourceId: "invoice_600",
        resource: {
          sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice", transactionDate: "2026-08-01",
          transactionNumber: "INV-600", dueDate: "2026-08-31", totalAmount: "100.00", openAmount: "100.00",
          sourceUpdatedAt, currencyCode: "USD",
          partyRef: { sourceObjectId: "customer_20", displayName: "Acme", partyType: "customer" },
          lines: [{
            sourceLineId: "invoice-line-1", lineNumber: 1, description: "Consulting", sourceAmount: "100.00",
            sourceQuantity: "2.00", sourceUnitAmount: "50.00",
            accountRef: { sourceObjectId: "revenue", displayName: "Revenue" }, postings: []
          }]
        }
      },
      {
        ...envelope, resourceType: "LedgerTransaction", resourceId: "payment_700",
        resource: {
          sourceTransactionId: "payment_700", sourceTransactionType: "Payment", transactionDate: "2026-08-10",
          transactionNumber: "PMT-700", totalAmount: paymentAmount, unappliedAmount: linked ? "0.00" : paymentAmount,
          sourceUpdatedAt, currencyCode: "USD",
          partyRef: { sourceObjectId: "customer_20", displayName: "Acme", partyType: "customer" },
          lines: [{
            sourceLineId: "payment-line-1", lineNumber: 1, description: "Invoice payment", sourceAmount: paymentAmount,
            accountRef: { sourceObjectId: "cash", displayName: "Cash" },
            linkedTransactions: linked ? [{ sourceTransactionId: "invoice_600", sourceTransactionType: "Invoice" }] : [],
            postings: []
          }]
        }
      }
    ]
  };
}

const quickBooksDocumentFamilyDefinitions = [
  { sourceId: "invoice_all", sourceType: "Invoice", number: "INV-ALL", date: "2026-08-01", dueDate: "2026-08-31", amount: "100.00", unitAmount: "50.00", partyId: "customer_qbo", partySourceId: "customer_20", partyType: "customer", accountId: "revenue" },
  { sourceId: "payment_all", sourceType: "Payment", number: "PMT-ALL", date: "2026-08-02", amount: "20.00", unitAmount: "10.00", partyId: "customer_qbo", partySourceId: "customer_20", partyType: "customer", accountId: "cash", linkedSourceId: "invoice_all", linkedSourceType: "Invoice" },
  { sourceId: "credit_all", sourceType: "CreditMemo", number: "CM-ALL", date: "2026-08-03", amount: "10.00", unitAmount: "5.00", partyId: "customer_qbo", partySourceId: "customer_20", partyType: "customer", accountId: "revenue", linkedSourceId: "invoice_all", linkedSourceType: "Invoice" },
  { sourceId: "refund_all", sourceType: "RefundReceipt", number: "REF-ALL", date: "2026-08-04", amount: "5.00", unitAmount: "2.50", partyId: "customer_qbo", partySourceId: "customer_20", partyType: "customer", accountId: "cash" },
  { sourceId: "bill_all", sourceType: "Bill", number: "BILL-ALL", date: "2026-08-05", dueDate: "2026-08-25", amount: "80.00", unitAmount: "40.00", partyId: "vendor_qbo", partySourceId: "vendor_30", partyType: "vendor", accountId: "expense" },
  { sourceId: "bill_payment_all", sourceType: "BillPayment", number: "BP-ALL", date: "2026-08-06", amount: "20.00", unitAmount: "10.00", partyId: "vendor_qbo", partySourceId: "vendor_30", partyType: "vendor", accountId: "cash", linkedSourceId: "bill_all", linkedSourceType: "Bill" },
  { sourceId: "deposit_all", sourceType: "Deposit", number: "DEP-ALL", date: "2026-08-07", amount: "30.00", unitAmount: "15.00", accountId: "cash" },
  { sourceId: "transfer_all", sourceType: "Transfer", number: "TRF-ALL", date: "2026-08-08", amount: "25.00", unitAmount: "12.50", accountId: "cash" },
  { sourceId: "sales_receipt_all", sourceType: "SalesReceipt", number: "SR-ALL", date: "2026-08-09", amount: "40.00", unitAmount: "20.00", partyId: "customer_qbo", partySourceId: "customer_20", partyType: "customer", accountId: "revenue" },
  { sourceId: "purchase_all", sourceType: "Purchase", number: "PUR-ALL", date: "2026-08-10", amount: "50.00", unitAmount: "25.00", partyId: "vendor_qbo", partySourceId: "vendor_30", partyType: "vendor", accountId: "expense" },
  { sourceId: "vendor_credit_all", sourceType: "VendorCredit", number: "VC-ALL", date: "2026-08-11", amount: "10.00", unitAmount: "5.00", partyId: "vendor_qbo", partySourceId: "vendor_30", partyType: "vendor", accountId: "expense", linkedSourceId: "bill_all", linkedSourceType: "Bill" }
] as const;

async function seedQuickBooksAllDocumentScope(pool: Pool): Promise<void> {
  await seedQuickBooksImportScope(pool);
  await pool.query(`
insert into erp_financials.accounts (
  account_id, tenant_id, source_id, source_account_id, name, type, classification, active
) values ('account_expense_qbo', 'tenant_qbo', 'source_qbo', 'expense', 'Expense', 'Expense', 'expense', true);
insert into erp_financials.parties (
  party_id, tenant_id, source_id, source_party_id, party_type, display_name, active
) values ('vendor_qbo', 'tenant_qbo', 'source_qbo', 'vendor_30', 'vendor', 'Supply Co', true);
delete from erp_financials.transactions
where tenant_id = 'tenant_qbo' and source_id = 'source_qbo';
`);
  for (const definition of quickBooksDocumentFamilyDefinitions) {
    await pool.query(
      `insert into erp_financials.transactions (
        transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type,
        transaction_number, transaction_date, posted_at, updated_at, party_id, currency_code, status,
        source_payload_ref
      ) values ($1, 'tenant_qbo', 'source_qbo', $2, $3, $4, $5, $6, $6, $7, 'USD', 'posted', '{}'::jsonb)`,
      [
        `transaction_${definition.sourceId}`,
        definition.sourceId,
        definition.sourceType,
        definition.number,
        definition.date,
        `${definition.date}T12:00:00Z`,
        "partyId" in definition ? definition.partyId : null
      ]
    );
  }
}

function quickBooksAllDocumentFacts(): CanonicalAccountingFactSet {
  const base = quickBooksSubledgerFacts();
  return {
    ...base,
    accounts: [
      ...base.accounts,
      { accountId: "account_expense_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourceAccountId: "expense", name: "Expense", type: "Expense", classification: "expense", active: true }
    ],
    parties: [
      ...base.parties,
      { partyId: "vendor_qbo", tenantId: "tenant_qbo", sourceId: "source_qbo", sourcePartyId: "vendor_30", partyType: "vendor", displayName: "Supply Co", active: true }
    ],
    transactions: quickBooksDocumentFamilyDefinitions.map((definition) => ({
      transactionId: `transaction_${definition.sourceId}`,
      tenantId: "tenant_qbo",
      sourceId: "source_qbo",
      sourceTransactionId: definition.sourceId,
      sourceTransactionType: definition.sourceType,
      transactionNumber: definition.number,
      transactionDate: definition.date,
      ...("partyId" in definition ? { partyId: definition.partyId } : {}),
      currencyCode: "USD",
      status: "posted" as const
    }))
  };
}

function quickBooksAllDocumentResources(): HandrailQuickBooksSdkResourceSet {
  const base = quickBooksSubledgerResources("20.00", false, "2026-08-10T10:00:00.000Z");
  return {
    ...base,
    operationalDocuments: quickBooksDocumentFamilyDefinitions.map((definition, index) => ({
      sourceSystem: "quickbooks" as const,
      tenantId: "tenant_qbo",
      sourceId: "source_qbo",
      providerEnvironment: "sandbox" as const,
      realmId: "realm_qbo",
      importBatchId: "batch_qbo",
      checkpointId: "checkpoint_qbo",
      sourceUpdatedAt: "2026-08-10T10:00:00.000Z",
      resourceType: "LedgerTransaction" as const,
      resourceId: definition.sourceId,
      resource: {
        sourceTransactionId: definition.sourceId,
        sourceTransactionType: definition.sourceType,
        transactionDate: definition.date,
        transactionNumber: definition.number,
        ...("dueDate" in definition ? { dueDate: definition.dueDate } : {}),
        totalAmount: definition.amount,
        sourceUpdatedAt: "2026-08-10T10:00:00.000Z",
        currencyCode: "USD",
        ...("partySourceId" in definition ? {
          partyRef: {
            sourceObjectId: definition.partySourceId,
            displayName: definition.partyType === "vendor" ? "Supply Co" : "Acme",
            partyType: definition.partyType
          }
        } : {}),
        lines: [{
          sourceLineId: `${definition.sourceId}-line-1`,
          lineNumber: 1,
          description: `${definition.sourceType} detail`,
          sourceAmount: definition.amount,
          sourceQuantity: "2.00",
          sourceUnitAmount: definition.unitAmount,
          taxCode: index === 0 ? "TAX" : "NON",
          accountRef: { sourceObjectId: definition.accountId, displayName: definition.accountId },
          ...("linkedSourceId" in definition ? {
            linkedTransactions: [{
              sourceTransactionId: definition.linkedSourceId,
              sourceTransactionType: definition.linkedSourceType
            }]
          } : {}),
          postings: []
        }]
      }
    }))
  };
}

async function quickBooksDocumentState(pool: Pool): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(`
select metadata ->> 'sourceTransactionId' as source_id, original_amount::text, open_amount::text, status
from erp_financials.subledger_documents
where tenant_id = 'tenant_qbo' and source_id = 'source_qbo'
order by source_id
`);
  return result.rows;
}

async function seedAccountingScope(pool: Pool): Promise<void> {
  await pool.query(`
insert into erp_financials.accounting_companies values ('company_1', 'tenant_1', 'One', 'One', 'USD', 1, 'test', 'native_erp', 'one');
insert into erp_financials.accounting_sources (source_id, tenant_id, source_system, provider_environment, connection_ref, status)
values ('source_1', 'tenant_1', 'native_erp', 'test', 'source:1', 'active'),
       ('source_2', 'tenant_1', 'native_erp', 'test', 'source:2', 'active');
insert into erp_financials.company_sources values ('company_source_1', 'tenant_1', 'company_1', 'source_1', now());
insert into erp_financials.accounts (account_id, tenant_id, source_id, source_account_id, name, type, classification, active)
values ('account_cash', 'tenant_1', 'source_1', 'cash', 'Cash', 'asset', 'asset', true),
       ('account_ar', 'tenant_1', 'source_1', 'ar', 'Receivable', 'asset', 'asset', true),
       ('account_ap', 'tenant_1', 'source_1', 'ap', 'Payable', 'liability', 'liability', true),
       ('account_income', 'tenant_1', 'source_1', 'income', 'Service Revenue', 'income', 'income', true);
insert into erp_financials.parties (party_id, tenant_id, source_id, source_party_id, party_type, display_name, active)
values ('customer_1', 'tenant_1', 'source_1', 'customer:1', 'customer', 'Customer One', true),
       ('customer_2', 'tenant_1', 'source_1', 'customer:2', 'customer', 'Customer Two', true),
       ('vendor_1', 'tenant_1', 'source_1', 'vendor:1', 'vendor', 'Vendor One', true);
insert into erp_financials.import_batches (import_batch_id, tenant_id, source_id, mode, status, started_at, completed_at, source_object_counts)
values ('batch_1', 'tenant_1', 'source_1', 'delta', 'completed', now(), now(), '{}'::jsonb);
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type, transaction_date,
  posted_at, updated_at, currency_code, status, source_payload_ref
) values ('journal_1', 'tenant_1', 'source_1', 'journal:1', 'JournalEntry', '2026-08-01', now(), now(), 'USD', 'posted', '{}'::jsonb);
insert into erp_financials.transaction_lines (
  transaction_line_id, tenant_id, source_id, transaction_id, line_number, account_id, amount, dimension_refs
) values ('line_1', 'tenant_1', 'source_1', 'journal_1', 1, 'account_cash', 10, '[]'::jsonb);
`);
}

function sdkOperation() {
  return {
    actorRef: "user:accountant",
    approverRef: "user:controller",
    requestId: "request:sdk-integration",
    correlationId: "correlation:sdk-integration",
    reasonCode: "sdk_integration_test",
    occurredAt: "2026-08-12T11:59:00.000Z"
  } as const;
}

function depositService(database: PostgresMigrationTransactionRunner, overrides: Partial<CreateErpFinancialsInput> = {}) {
  return createErpFinancials({
    database, tenantId: "tenant_1", companyId: "company_1", sourceId: "source_1", currencyCode: "USD",
    now: () => "2026-08-12T12:00:00.000Z", ...overrides
  });
}

async function closeDepositPeriod(pool: Pool, financials: ReturnType<typeof depositService>) {
  const periods = await pool.query<{ fiscal_period_id: string }>("select fiscal_period_id from erp_financials.fiscal_periods");
  const fiscalPeriodId = String(periods.rows[0]?.fiscal_period_id);
  const closing = await financials.fiscalPeriods.beginClose({ operation: sdkOperation(), fiscalPeriodId, expectedVersion: 1 });
  const evidence = { trialBalanceSnapshotId: "deposit-trial-balance", reconciliationRefs: ["deposit-reconciliation"],
    checklistRef: "deposit-close-checklist", postingMaxUpdatedAt: "2026-08-12T12:00:00.000Z" };
  await financials.fiscalPeriods.close({ operation: sdkOperation(), fiscalPeriodId, expectedVersion: closing.version,
    evidence: { ...evidence, evidenceChecksum: createFiscalCloseEvidenceChecksum(evidence) } });
}

/** Compare all persisted rows, including audit/outbox/freshness, on failed commands. */
async function depositDatabaseState(pool: Pool): Promise<Record<string, unknown[]>> {
  const tables = await pool.query<{ table_name: string }>(`select table_name from information_schema.tables
    where table_schema = 'erp_financials' and table_type = 'BASE TABLE' order by table_name`);
  const state: Record<string, unknown[]> = {};
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_]+$/u.test(table)) throw new Error("Unexpected table name");
    state[table] = (await pool.query(`select to_jsonb(row) as row from erp_financials."${table}" row order by to_jsonb(row)::text`)).rows;
  }
  return state;
}

async function reconciliationEvidenceCounts(
  pool: Pool,
  aggregateId: string,
  eventType: string
): Promise<{ readonly auditCount: number; readonly outboxCount: number }> {
  const result = await pool.query<{ audit_count: number; outbox_count: number }>(
    `select
  (select count(*)::integer from erp_financials.financial_lifecycle_events
   where aggregate_id = $1 and event_type = $2) as audit_count,
  (select count(*)::integer from erp_financials.financial_outbox
   where aggregate_id = $1 and event_type = $2) as outbox_count`,
    [aggregateId, eventType]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Expected reconciliation evidence counts");
  return { auditCount: row.audit_count, outboxCount: row.outbox_count };
}

async function seedSubledgerDocuments(pool: Pool): Promise<void> {
  await pool.query(`
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type, transaction_date,
  posted_at, updated_at, party_id, currency_code, status, source_payload_ref
) values
  ('txn_invoice', 'tenant_1', 'source_1', 'invoice:1', 'Subledger:invoice', '2026-08-01', now(), now(), 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_payment', 'tenant_1', 'source_1', 'payment:1', 'Subledger:customer_payment', '2026-08-05', now(), now(), 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_payment_other', 'tenant_1', 'source_1', 'payment:other', 'Subledger:customer_payment', '2026-08-05', now(), now(), 'customer_2', 'USD', 'posted', '{}'::jsonb),
  ('txn_payment_eur', 'tenant_1', 'source_1', 'payment:eur', 'Subledger:customer_payment', '2026-08-05', now(), now(), 'customer_1', 'EUR', 'posted', '{}'::jsonb);
insert into erp_financials.financial_lifecycle_events values
  ('event_invoice', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'invoice_1', 'posted', 'user:1', null, 'request:invoice', 'correlation:1', 'test', null, now(), now(), 'event_invoice', repeat('a',64), '{}'::jsonb, null),
  ('event_payment', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'payment_1', 'posted', 'user:1', null, 'request:payment', 'correlation:1', 'test', null, now(), now(), 'event_payment', repeat('a',64), '{}'::jsonb, null),
  ('event_payment_other', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'payment_other_party', 'posted', 'user:1', null, 'request:payment-other', 'correlation:1', 'test', null, now(), now(), 'event_payment_other', repeat('a',64), '{}'::jsonb, null),
  ('event_payment_eur', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'payment_eur', 'posted', 'user:1', null, 'request:payment-eur', 'correlation:1', 'test', null, now(), now(), 'event_payment_eur', repeat('a',64), '{}'::jsonb, null),
  ('event_apply', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_1', 'applied', 'user:1', null, 'request:apply', 'correlation:1', 'test', null, now(), now(), 'event_apply', repeat('a',64), '{}'::jsonb, null);
insert into erp_financials.subledger_documents (
  subledger_document_id, tenant_id, company_id, source_id, document_type, transaction_id, party_id,
  document_date, currency_code, original_amount, open_amount, status, version, idempotency_key,
  lifecycle_event_id, metadata, created_at, updated_at
) values
  ('invoice_1', 'tenant_1', 'company_1', 'source_1', 'invoice', 'txn_invoice', 'customer_1', '2026-08-01', 'USD', 100, 100, 'open', 1, 'invoice_1', 'event_invoice', '{}'::jsonb, now(), now()),
  ('payment_1', 'tenant_1', 'company_1', 'source_1', 'customer_payment', 'txn_payment', 'customer_1', '2026-08-05', 'USD', 60, 60, 'open', 1, 'payment_1', 'event_payment', '{}'::jsonb, now(), now()),
  ('payment_other_party', 'tenant_1', 'company_1', 'source_1', 'customer_payment', 'txn_payment_other', 'customer_2', '2026-08-05', 'USD', 10, 10, 'open', 1, 'payment_other_party', 'event_payment_other', '{}'::jsonb, now(), now()),
  ('payment_eur', 'tenant_1', 'company_1', 'source_1', 'customer_payment', 'txn_payment_eur', 'customer_1', '2026-08-05', 'EUR', 10, 10, 'open', 1, 'payment_eur', 'event_payment_eur', '{}'::jsonb, now(), now());
`);
}

async function seedCustomerStatementScenario(pool: Pool): Promise<void> {
  await seedSubledgerDocuments(pool);
  await pool.query(`
insert into erp_financials.reporting_books (
  tenant_id, company_id, book_id, name, base_currency_code, accounting_basis, status, created_at, updated_at
) values
  ('tenant_1', 'company_1', 'book_1', 'Primary', 'USD', 'accrual', 'active', now(), now()),
  ('tenant_1', 'company_1', 'book_2', 'Isolated', 'USD', 'accrual', 'active', now(), now());
insert into erp_financials.reporting_book_sources (
  book_source_id, tenant_id, company_id, book_id, source_id, source_role, created_at
) values ('book_source_statement', 'tenant_1', 'company_1', 'book_1', 'source_1', 'active', now());
insert into erp_financials.transactions (
  transaction_id, tenant_id, source_id, source_transaction_id, source_transaction_type, transaction_number,
  transaction_date, posted_at, updated_at, party_id, currency_code, status, source_payload_ref
) values
  ('txn_invoice_full', 'tenant_1', 'source_1', 'invoice:full', 'Subledger:invoice', 'INV-FULL',
    '2026-08-02', '2026-08-02T12:00:00Z', '2026-08-02T12:00:00Z', 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_payment_full', 'tenant_1', 'source_1', 'payment:full', 'Subledger:customer_payment', 'PAY-FULL',
    '2026-08-10', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z', 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_invoice_future', 'tenant_1', 'source_1', 'invoice:future', 'Subledger:invoice', 'INV-FUTURE',
    '2026-09-01', '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z', 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_payment_future', 'tenant_1', 'source_1', 'payment:future', 'Subledger:customer_payment', 'PAY-FUTURE',
    '2026-09-03', '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z', 'customer_1', 'USD', 'posted', '{}'::jsonb),
  ('txn_invoice_other', 'tenant_1', 'source_1', 'invoice:other', 'Subledger:invoice', 'INV-OTHER',
    '2026-08-03', '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z', 'customer_2', 'USD', 'posted', '{}'::jsonb);
insert into erp_financials.financial_lifecycle_events values
  ('event_invoice_full', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'invoice_full', 'posted',
    'user:1', null, 'request:invoice-full', 'correlation:statement', 'test', null,
    '2026-08-02T12:00:00Z', '2026-08-02T12:00:00Z', 'event_invoice_full', repeat('a',64), '{}'::jsonb, null),
  ('event_payment_full', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'payment_full', 'posted',
    'user:1', null, 'request:payment-full', 'correlation:statement', 'test', null,
    '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z', 'event_payment_full', repeat('a',64), '{}'::jsonb, null),
  ('event_apply_full', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_full', 'applied',
    'user:1', null, 'request:apply-full', 'correlation:statement', 'test', null,
    '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z', 'event_apply_full', repeat('a',64), '{}'::jsonb, null),
  ('event_invoice_future', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'invoice_future', 'posted',
    'user:1', null, 'request:invoice-future', 'correlation:statement', 'test', null,
    '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z', 'event_invoice_future', repeat('a',64), '{}'::jsonb, null),
  ('event_payment_future', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'payment_future', 'posted',
    'user:1', null, 'request:payment-future', 'correlation:statement', 'test', null,
    '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z', 'event_payment_future', repeat('a',64), '{}'::jsonb, null),
  ('event_apply_future', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_future', 'applied',
    'user:1', null, 'request:apply-future', 'correlation:statement', 'test', null,
    '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z', 'event_apply_future', repeat('a',64), '{}'::jsonb, null),
  ('event_invoice_other', 'tenant_1', 'company_1', 'source_1', 'subledger_document', 'invoice_other', 'posted',
    'user:1', null, 'request:invoice-other', 'correlation:statement', 'test', null,
    '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z', 'event_invoice_other', repeat('a',64), '{}'::jsonb, null),
  ('event_statement_unapply', 'tenant_1', 'company_1', 'source_1', 'subledger_application', 'application_1', 'unapplied',
    'user:1', 'user:2', 'request:statement-unapply', 'correlation:statement', 'test', null,
    '2026-09-05T12:00:00Z', '2026-09-05T12:00:00Z', 'event_statement_unapply', repeat('a',64), '{}'::jsonb, 'event_apply');
insert into erp_financials.subledger_documents (
  subledger_document_id, tenant_id, company_id, source_id, document_type, transaction_id, party_id,
  document_number, document_date, due_date, currency_code, original_amount, open_amount, status, version,
  idempotency_key, lifecycle_event_id, metadata, created_at, updated_at
) values
  ('invoice_full', 'tenant_1', 'company_1', 'source_1', 'invoice', 'txn_invoice_full', 'customer_1',
    'INV-FULL', '2026-08-02', '2026-08-31', 'USD', 30, 30, 'open', 1,
    'invoice_full', 'event_invoice_full', '{}'::jsonb, '2026-08-02T12:00:00Z', '2026-08-02T12:00:00Z'),
  ('payment_full', 'tenant_1', 'company_1', 'source_1', 'customer_payment', 'txn_payment_full', 'customer_1',
    'PAY-FULL', '2026-08-10', null, 'USD', 30, 30, 'open', 1,
    'payment_full', 'event_payment_full', '{}'::jsonb, '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('invoice_future', 'tenant_1', 'company_1', 'source_1', 'invoice', 'txn_invoice_future', 'customer_1',
    'INV-FUTURE', '2026-09-01', '2026-09-30', 'USD', 70, 70, 'open', 1,
    'invoice_future', 'event_invoice_future', '{}'::jsonb, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z'),
  ('payment_future', 'tenant_1', 'company_1', 'source_1', 'customer_payment', 'txn_payment_future', 'customer_1',
    'PAY-FUTURE', '2026-09-03', null, 'USD', 40, 40, 'open', 1,
    'payment_future', 'event_payment_future', '{}'::jsonb, '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z'),
  ('invoice_other', 'tenant_1', 'company_1', 'source_1', 'invoice', 'txn_invoice_other', 'customer_2',
    'INV-OTHER', '2026-08-03', '2026-08-31', 'USD', 80, 80, 'open', 1,
    'invoice_other', 'event_invoice_other', '{}'::jsonb, '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z');
insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values
  ('application_1', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice', 'payment_1',
    'invoice_1', 60, 'USD', '2026-08-05', 'applied', 1, 'statement_apply_1', 'event_apply', now(), now()),
  ('application_full', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice', 'payment_full',
    'invoice_full', 30, 'USD', '2026-08-10', 'applied', 1, 'statement_apply_full', 'event_apply_full',
    '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z');
update erp_financials.subledger_applications
set status = 'unapplied', version = 2, ended_event_id = 'event_statement_unapply', updated_at = '2026-09-05T12:00:00Z'
where subledger_application_id = 'application_1';
insert into erp_financials.subledger_applications (
  subledger_application_id, tenant_id, company_id, source_id, application_type, source_document_id,
  target_document_id, applied_amount, currency_code, application_date, status, version, idempotency_key,
  applied_event_id, created_at, updated_at
) values ('application_future', 'tenant_1', 'company_1', 'source_1', 'customer_payment_to_invoice', 'payment_future',
  'invoice_1', 40, 'USD', '2026-09-03', 'applied', 1, 'statement_apply_future', 'event_apply_future',
  '2026-09-03T12:00:00Z', '2026-09-03T12:00:00Z');
`);
}

async function documentBalances(pool: Pool): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query<{
    readonly subledger_document_id: string;
    readonly open_amount: string;
    readonly status: string;
    readonly version: number;
  }>(
    "select subledger_document_id, open_amount::text, status, version from erp_financials.subledger_documents where subledger_document_id in ('invoice_1', 'payment_1') order by subledger_document_id"
  );
  return result.rows;
}

async function creditOwnershipFixture(pool: Pool, customer: boolean) {
  await seedQuickBooksAllDocumentScope(pool);
  const base = quickBooksAllDocumentFacts();
  const types = customer ? ["credit_all", "invoice_all", "payment_all"] : ["vendor_credit_all", "bill_all", "bill_payment_all"];
  const ids = ["2572", "2573", "2574"];
  const resources: HandrailQuickBooksSdkResourceSet = {
    ...quickBooksAllDocumentResources(),
    operationalDocuments: types.map((type, index) => {
      const template = quickBooksAllDocumentResources().operationalDocuments?.find(row => row.resourceId === type);
      if (!template) throw new Error(`Missing fixture ${type}`);
      const id = ids[index];
      if (id === undefined) throw new Error("Missing fixture ID");
      const amount = index === 0 ? "1922.58" : index === 1 ? "1861.52" : "0.00";
      return { ...template, resourceId: id, resource: { ...template.resource,
        sourceTransactionId: id, transactionDate: index === 0 ? "2025-07-25" : "2025-08-19",
        dueDate: "2025-09-18", totalAmount: amount, openAmount: "0.00",
        ...(index === 2 ? { unappliedAmount: "0.00" } : {}),
        lines: index === 2 ? [0, 1].map(link => ({ sourceLineId: String(link + 1), lineNumber: link + 1,
          sourceAmount: "1861.52", linkedTransactions: [{ sourceTransactionId: link === 0 ? "2572" : "2573",
            sourceTransactionType: link === 0 ? (customer ? "CreditMemo" : "VendorCredit") : (customer ? "Invoice" : "Bill") }], postings: [] })) :
          [{ sourceLineId: "1", lineNumber: 1, sourceAmount: amount,
            accountRef: { sourceObjectId: customer ? "revenue" : "expense" }, postings: [] }]
      } };
    })
  };
  const facts: CanonicalAccountingFactSet = { ...base,
    transactions: types.slice(0, 2).map((type, index) => {
      const transaction = base.transactions.find(row => row.sourceTransactionId === type);
      if (!transaction) throw new Error(`Missing transaction ${type}`);
      return { ...transaction, sourceTransactionId: index === 0 ? "2572" : "2573" };
    }) };
  for (const transaction of facts.transactions) {
    await pool.query(`update erp_financials.transactions set source_transaction_id = $1 where transaction_id = $2`,
      [transaction.sourceTransactionId, transaction.transactionId]);
  }
  return { facts, resources };
}

async function creditOwnershipState(pool: Pool) {
  return {
    documents: await quickBooksDocumentState(pool),
    applications: (await pool.query<Record<string, unknown>>(`select subledger_application_id, applied_amount::text, status, version, applied_event_id, ended_event_id
      from erp_financials.subledger_applications order by subledger_application_id`)).rows,
    events: (await pool.query(`select * from erp_financials.financial_lifecycle_events order by event_id`)).rows,
    postings: (await pool.query(`select * from erp_financials.ledger_postings order by posting_id`)).rows
  };
}
