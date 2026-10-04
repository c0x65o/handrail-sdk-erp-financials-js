import { describe, expect, it } from "vitest";

import {
  ErpFinancialsIdempotencyConflictError,
  ErpFinancialsValidationError,
  createErpFinancials,
  createPostgresTransactionRunner
} from "../src/index.js";

import type {
  ErpFinancialsTransactionRunner,
  ErpFinancialsPostgresTransactionClient,
  PostJournalEntryInput,
  PostgresQueryClient,
  PostgresQueryResult
} from "../src/index.js";

type QueryCall = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

type StoredJournal = {
  readonly transaction_id: string;
  readonly status: string;
  readonly source_payload_ref: unknown;
};

describe("reusable ERP Financials service", () => {
  it("adapts a standard Postgres pool with commit, rollback, and connection release", async () => {
    const successfulClient = new PoolTransactionClient();
    const successfulRunner = createPostgresTransactionRunner({
      connect: () => Promise.resolve(successfulClient)
    });

    await expect(
      successfulRunner.transaction(async (client) => {
        await client.query("select 'work'");
        return "done";
      })
    ).resolves.toBe("done");
    expect(successfulClient.sql).toEqual(["begin", "select 'work'", "commit"]);
    expect(successfulClient.releaseCalls).toBe(1);

    const failedClient = new PoolTransactionClient();
    const failedRunner = createPostgresTransactionRunner({
      connect: () => Promise.resolve(failedClient)
    });

    await expect(
      failedRunner.transaction(() => Promise.reject(new Error("operation failed")))
    ).rejects.toThrow("operation failed");
    expect(failedClient.sql).toEqual(["begin", "rollback"]);
    expect(failedClient.releaseCalls).toBe(1);
  });

  it("upserts an arbitrary-depth account tree and invalidates hierarchy-dependent snapshots atomically", async () => {
    const database = new ServiceTestDatabase();
    const financials = service(database);

    const result = await financials.accounts.upsertTree({
      operation: operation("request-account-tree-depth"),
      parent: {
        accountId: "acct_service_revenue",
        accountNumber: "4000",
        name: "Service Revenue",
        classification: "income"
      },
      children: [
        {
          accountId: "acct_setup_fee",
          accountNumber: "4010",
          name: "Setup Fee",
          classification: "income"
        },
        {
          accountId: "acct_access_fee",
          accountNumber: "4020",
          name: "Access Fee",
          classification: "income",
          children: [
            {
              accountId: "acct_premium_access",
              accountNumber: "4021",
              name: "Premium Access",
              classification: "income"
            }
          ]
        }
      ]
    });

    expect(database.transactionCalls).toBe(1);
    expect(database.commits).toBe(1);
    expect(database.rollbacks).toBe(0);
    expect(result.accountsWritten).toBe(4);
    expect(result.snapshotsMarkedStale).toBe(2);
    expect(result.accounts.map((account) => [account.accountId, account.parentAccountId])).toEqual([
      ["acct_service_revenue", undefined],
      ["acct_setup_fee", "acct_service_revenue"],
      ["acct_access_fee", "acct_service_revenue"],
      ["acct_premium_access", "acct_access_fee"]
    ]);

    const accountInsert = requiredCall(database.client.calls, 'insert into "erp_financials"."accounts"');
    const accountRows = insertedRows(accountInsert);
    expect(accountRows).toHaveLength(4);
    expect(accountRows[3]).toMatchObject({
      account_id: "acct_premium_access",
      parent_account_id: "acct_access_fee",
      source_account_id: "acct_premium_access",
      tenant_id: "tenant_service",
      source_id: "source_service"
    });
    expect(database.client.calls.some((call) => call.sql.includes('update "erp_financials"."report_snapshots" rs'))).toBe(true);
    expect(result.lifecycleEventId).toMatch(/^event_[a-f0-9]{24}$/);
  });

  it("derives scoped canonical ids from reusable account keys across tree and journal calls", async () => {
    const database = new ServiceTestDatabase();
    const financials = service(database);
    const tree = await financials.accounts.upsertTree({
      operation: operation("request-account-tree-keys"),
      parent: {
        accountKey: "service-revenue",
        name: "Service Revenue",
        classification: "income"
      },
      children: [
        { accountKey: "setup-fee", name: "Setup Fee", classification: "income" },
        { accountKey: "access-fee", name: "Access Fee", classification: "income" }
      ]
    });
    const accountIdsBySourceId = Object.fromEntries(
      tree.accounts.map((account) => [account.sourceAccountId, account.accountId])
    );

    expect(accountIdsBySourceId["service-revenue"]).toMatch(/^account_[a-f0-9]{16}$/);
    expect(accountIdsBySourceId["setup-fee"]).toMatch(/^account_[a-f0-9]{16}$/);
    expect(accountIdsBySourceId["access-fee"]).toMatch(/^account_[a-f0-9]{16}$/);
    expect(tree.accounts[1]?.parentAccountId).toBe(accountIdsBySourceId["service-revenue"]);

    const otherTenantTree = await createErpFinancials({
      database: new ServiceTestDatabase(),
      tenantId: "tenant_other",
      companyId: "company_other",
      sourceId: "source_service",
      currencyCode: "USD"
    }).accounts.upsertTree({
      operation: operation("request-other-tenant-tree"),
      parent: {
        accountKey: "service-revenue",
        name: "Service Revenue",
        classification: "income"
      }
    });
    expect(otherTenantTree.accounts[0]?.accountId).not.toBe(accountIdsBySourceId["service-revenue"]);

    await financials.journalEntries.post({
      operation: operation("request-account-key-reclassification"),
      idempotencyKey: "account-key-reclassification",
      date: "2026-08-12",
      lines: [
        { accountKey: "service-revenue", debit: "100.00" },
        { accountKey: "setup-fee", credit: "30.00" },
        { accountKey: "access-fee", credit: "70.00" }
      ]
    });

    const postingInsert = database.client.calls
      .filter((call) => call.sql.includes('insert into "erp_financials"."ledger_postings"'))
      .at(-1);
    if (postingInsert === undefined) {
      throw new Error("Expected journal ledger posting insert");
    }
    expect(insertedRows(postingInsert).map((row) => row.account_id)).toEqual([
      accountIdsBySourceId["service-revenue"],
      accountIdsBySourceId["setup-fee"],
      accountIdsBySourceId["access-fee"]
    ]);
  });

  it("posts a balanced journal with stable ids and treats an identical retry as a no-op", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    const financials = service(database);
    const input = reclassificationEntry();

    const first = await financials.journalEntries.post(input);

    expect(first.status).toBe("posted");
    expect(first.transactionId).toMatch(/^transaction_[a-f0-9]{16}$/);
    expect(first.transactionLineIds).toHaveLength(3);
    expect(first.postingIds).toHaveLength(3);
    expect(first.writeCounts).toEqual({
      importBatches: 1,
      transactions: 1,
      transactionLines: 3,
      postings: 3
    });
    expect(first.snapshotsMarkedStale).toBe(2);
    expect(database.transactionCalls).toBe(1);
    expect(database.commits).toBe(1);

    const postingInsert = requiredCall(database.client.calls, 'insert into "erp_financials"."ledger_postings"');
    expect(insertedRows(postingInsert).map((row) => ({
      accountId: row.account_id,
      debit: row.debit_amount,
      credit: row.credit_amount,
      net: row.net_amount
    }))).toEqual([
      { accountId: "acct_service_revenue", debit: "100.00", credit: "0.00", net: "100.00" },
      { accountId: "acct_setup_fee", debit: "0.00", credit: "30.00", net: "-30.00" },
      { accountId: "acct_access_fee", debit: "0.00", credit: "70.00", net: "-70.00" }
    ]);
    const staleUpdate = requiredCall(database.client.calls, 'update "erp_financials"."report_snapshots"');
    expect(staleUpdate.sql).toContain('rs."company_id" = $5');
    expect(staleUpdate.sql).toContain('rs."source_id" = $6');
    expect(staleUpdate.sql).not.toContain('"report_freshness"');
    expect(staleUpdate.params).toEqual([
      "tenant_service",
      "2026-08-12",
      "2026-08-12",
      "journal_entry_posted",
      "company_service",
      "source_service",
      "accrual",
      "USD"
    ]);

    const callCountBeforeRetry = database.client.calls.length;
    const retry = await financials.journalEntries.post(input);
    const retryCalls = database.client.calls.slice(callCountBeforeRetry);

    expect(retry).toEqual({
      ...first,
      status: "already_posted",
      snapshotsMarkedStale: 0,
      writeCounts: {
        importBatches: 0,
        transactions: 0,
        transactionLines: 0,
        postings: 0
      }
    });
    expect(
      retryCalls.some(
        (call) =>
          call.sql.startsWith("insert into") && !call.sql.includes('"erp_financials"."financial_lifecycle_events"')
      )
    ).toBe(false);
    expect(database.transactionCalls).toBe(2);
    expect(database.commits).toBe(2);
  });

  it("rejects an idempotency key reused with different journal content", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    const financials = service(database);

    await financials.journalEntries.post(reclassificationEntry());
    const callsBeforeConflict = database.client.calls.length;

    await expect(
      financials.journalEntries.post({
        ...reclassificationEntry(),
        lines: [
          { accountId: "acct_service_revenue", debit: "100.00" },
          { accountId: "acct_setup_fee", credit: "40.00" },
          { accountId: "acct_access_fee", credit: "60.00" }
        ]
      })
    ).rejects.toBeInstanceOf(ErpFinancialsIdempotencyConflictError);

    expect(database.client.calls.slice(callsBeforeConflict).some((call) => call.sql.startsWith("insert into"))).toBe(false);
    expect(database.rollbacks).toBe(1);
  });

  it("rejects unbalanced journals before opening a database transaction", async () => {
    const database = new ServiceTestDatabase();
    const financials = service(database);

    await expect(
      financials.journalEntries.post({
        operation: operation("request-unbalanced-entry"),
        idempotencyKey: "unbalanced-entry",
        date: "2026-08-12",
        lines: [
          { accountId: "acct_service_revenue", debit: "100.00" },
          { accountId: "acct_setup_fee", credit: "99.99" }
        ]
      })
    ).rejects.toThrow("unbalanced: debits 100.00, credits 99.99");

    expect(database.transactionCalls).toBe(0);
  });

  it("rejects inactive or missing posting accounts and rolls back without ledger writes", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", false)
    ]);
    const financials = service(database);

    await expect(
      financials.journalEntries.post({
        operation: operation("request-inactive-entry"),
        idempotencyKey: "inactive-entry",
        date: "2026-08-12",
        lines: [
          { accountId: "acct_service_revenue", debit: "100.00" },
          { accountId: "acct_setup_fee", credit: "100.00" }
        ]
      })
    ).rejects.toThrow("inactive accounts: acct_setup_fee");

    expect(database.rollbacks).toBe(1);
    expect(database.client.calls.some((call) => call.sql.includes('insert into "erp_financials"."ledger_postings"'))).toBe(false);
  });

  it("keeps all journal writes and invalidation inside the caller-provided transaction", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    database.client.failInsertTable = "ledger_postings";
    const financials = service(database);

    await expect(financials.journalEntries.post(reclassificationEntry())).rejects.toThrow("simulated ledger write failure");

    expect(database.transactionCalls).toBe(1);
    expect(database.commits).toBe(0);
    expect(database.rollbacks).toBe(1);
    expect(database.client.calls.some((call) => call.sql.includes('update "erp_financials"."report_snapshots"'))).toBe(false);
  });

  it.each([
    ["reverse", "reversed", "reversal"],
    ["void", "voided", "void"]
  ] as const)("%ss a posted journal with a new opposite entry and immutable linkage", async (method, outcome, linkType) => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    const financials = service(database);
    const original = await financials.journalEntries.post(reclassificationEntry());
    const originalStored = structuredClone(
      database.client.storedJournals.get("JournalEntry:service-revenue-reclass-2026-08")
    );

    const result = await financials.journalEntries[method]({
      originalTransactionId: original.transactionId,
      idempotencyKey: `workflow-${method}`,
      date: "2026-08-13",
      operation: approvedOperation(`request-${method}`)
    });

    expect(result.outcome).toBe(outcome);
    expect(result.reversal.transactionId).not.toBe(original.transactionId);
    expect(database.client.storedJournals.get("JournalEntry:service-revenue-reclass-2026-08")).toEqual(
      originalStored
    );
    const reversalPostings = database.client.storedPostings.filter(
      (posting) => posting.transaction_id === result.reversal.transactionId
    );
    expect(reversalPostings.map((posting) => [posting.debit_amount, posting.credit_amount])).toEqual(
      expect.arrayContaining([
        ["0.00", "100.00"],
        ["30.00", "0.00"],
        ["70.00", "0.00"]
      ])
    );
    expect(database.client.journalLinks).toEqual([
      expect.objectContaining({
        original_transaction_id: original.transactionId,
        related_transaction_id: result.reversal.transactionId,
        link_type: linkType
      })
    ]);
  });

  it("prevents a second terminal reversal or void workflow for the same journal", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    const financials = service(database);
    const original = await financials.journalEntries.post(reclassificationEntry());
    await financials.journalEntries.reverse({
      originalTransactionId: original.transactionId,
      idempotencyKey: "first-terminal-workflow",
      date: "2026-08-13",
      operation: approvedOperation("request-first-terminal-workflow")
    });

    await expect(
      financials.journalEntries.void({
        originalTransactionId: original.transactionId,
        idempotencyKey: "second-terminal-workflow",
        date: "2026-08-14",
        operation: approvedOperation("request-second-terminal-workflow")
      })
    ).rejects.toThrow("already has a terminal reversal workflow");
    expect(database.client.journalLinks).toHaveLength(1);
  });

  it.each([
    ["correct", "corrected", "correction"],
    ["replace", "replaced", "replacement"]
  ] as const)("%ss a journal with atomic reversal and replacement entries", async (method, outcome, linkType) => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_setup_fee", true),
      accountRow("acct_access_fee", true)
    ]);
    const financials = service(database);
    const original = await financials.journalEntries.post(reclassificationEntry());

    const result = await financials.journalEntries[method]({
      originalTransactionId: original.transactionId,
      idempotencyKey: `workflow-${method}`,
      date: "2026-08-13",
      operation: approvedOperation(`request-${method}`),
      replacement: {
        idempotencyKey: `workflow-${method}:replacement-entry`,
        date: "2026-08-13",
        memo: "Corrected classification",
        lines: [
          { accountId: "acct_service_revenue", debit: "100.00" },
          { accountId: "acct_setup_fee", credit: "25.00" },
          { accountId: "acct_access_fee", credit: "75.00" }
        ]
      }
    });

    expect(result).toMatchObject({ outcome, originalTransactionId: original.transactionId });
    expect(result.replacement?.transactionId).toBeDefined();
    expect(result.journalEntryLinkIds).toHaveLength(2);
    expect(database.transactionCalls).toBe(2);
    expect(database.client.journalLinks.map((link) => link.link_type)).toEqual(["reversal", linkType]);
    expect(database.client.storedJournals.size).toBe(3);
  });

  it("requires an independent approver before opening a journal lifecycle transaction", async () => {
    const database = new ServiceTestDatabase();
    const financials = service(database);

    await expect(
      financials.journalEntries.reverse({
        originalTransactionId: "transaction_original",
        idempotencyKey: "reverse-without-approval",
        date: "2026-08-13",
        operation: operation("request-reverse-no-approval")
      })
    ).rejects.toThrow("operation.approverRef is required");
    expect(database.transactionCalls).toBe(0);
  });

  it("mirrors a manual journal only when the caller explicitly selects the dual-basis policy", async () => {
    const database = new ServiceTestDatabase([
      accountRow("acct_service_revenue", true),
      accountRow("acct_receivable", true)
    ]);
    const financials = service(database);
    const posted = await financials.journalEntries.post({
      operation: operation("request-dual-basis-journal"),
      idempotencyKey: "dual-basis-journal",
      date: "2026-08-12",
      accountingBasis: "accrual",
      accountingPolicy: "mirror_cash_and_accrual",
      lines: [
        { accountId: "acct_receivable", debit: "10.00" },
        { accountId: "acct_service_revenue", credit: "10.00" }
      ]
    });
    expect(database.client.storedPostings.map((posting) => posting.accounting_basis).sort()).toEqual([
      "accrual", "accrual", "cash", "cash"
    ]);
    await financials.journalEntries.reverse({
      operation: approvedOperation("request-dual-basis-journal-reverse"),
      originalTransactionId: posted.transactionId,
      idempotencyKey: "dual-basis-journal-reverse",
      date: "2026-08-13"
    });
    expect(database.client.storedPostings.filter((posting) => posting.accounting_basis === "cash")).toHaveLength(4);
  });

  it("atomically creates invoices and payments, applies once, and restores both balances on unapply", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-invoice"),
      idempotencyKey: "invoice-1001",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [
        { accountId: "acct_service_revenue", amount: "70.00" },
        { accountId: "acct_access_fee", amount: "30.00" }
      ]
    });
    const payment = await financials.customerPayments.record({
      operation: operation("request-payment"),
      idempotencyKey: "payment-1001",
      date: "2026-08-05",
      customerId: "customer_acme",
      amount: "60.00",
      cashAccount: { accountId: "acct_cash" },
      receivableAccount: { accountId: "acct_receivable" },
      provenance: {
        externalBankMatch: {
          externalMatchId: "bank-match-1001",
          bankStatementLineId: "bank-line-1001",
          matchedAt: "2026-08-05T14:00:00.000Z"
        },
        deposit: { depositId: "deposit-1001", depositedAt: "2026-08-06T14:00:00.000Z" }
      }
    });

    expect(JSON.parse(String(subledgerRow(database, payment.documentId).metadata))).toEqual({
      customerPaymentProvenance: {
        externalBankMatch: {
          externalMatchId: "bank-match-1001",
          bankStatementLineId: "bank-line-1001",
          matchedAt: "2026-08-05T14:00:00.000Z"
        },
        deposit: { depositId: "deposit-1001", depositedAt: "2026-08-06T14:00:00.000Z" }
      }
    });

    const applied = await financials.paymentApplications.apply({
      operation: operation("request-apply"),
      idempotencyKey: "apply-payment-1001",
      applicationType: "customer_payment_to_invoice",
      sourceDocumentId: payment.documentId,
      targetDocumentId: invoice.documentId,
      amount: "60.00",
      applicationDate: "2026-08-05",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    });
    const retry = await financials.paymentApplications.apply({
      operation: operation("request-apply-retry"),
      idempotencyKey: "apply-payment-1001",
      applicationType: "customer_payment_to_invoice",
      sourceDocumentId: payment.documentId,
      targetDocumentId: invoice.documentId,
      amount: "60.00",
      applicationDate: "2026-08-05",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    });

    expect(applied).toMatchObject({ status: "applied", appliedAmount: "60.00", version: 1 });
    expect(database.client.storedPostings.filter((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:${applied.applicationId}:recognize:`)
    )).toHaveLength(3);
    expect(retry).toEqual({ ...applied, status: "already_applied" });
    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-apply-conflict"),
        idempotencyKey: "apply-payment-1001",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "60.00",
        applicationDate: "2026-08-06",
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      })
    ).rejects.toBeInstanceOf(ErpFinancialsIdempotencyConflictError);
    expect(subledgerRow(database, payment.documentId)).toMatchObject({
      open_amount: "0.00",
      status: "settled",
      version: 2
    });
    expect(subledgerRow(database, invoice.documentId)).toMatchObject({
      open_amount: "40.00",
      status: "partially_applied",
      version: 2
    });

    const unapplied = await financials.paymentApplications.unapply({
      operation: approvedOperation("request-unapply"),
      applicationId: applied.applicationId,
      effectiveDate: "2026-08-06",
      expectedVersion: 1
    });
    expect(database.client.storedPostings.filter((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:${applied.applicationId}:reverse:`)
    )).toHaveLength(3);
    const unapplyRetry = await financials.paymentApplications.unapply({
      operation: approvedOperation("request-unapply-retry"),
      applicationId: applied.applicationId,
      effectiveDate: "2026-08-06",
      expectedVersion: 1
    });

    expect(unapplied).toMatchObject({ status: "unapplied", version: 2 });
    expect(unapplyRetry).toEqual(unapplied);
    expect(subledgerRow(database, payment.documentId)).toMatchObject({ open_amount: "60.00", status: "open", version: 3 });
    expect(subledgerRow(database, invoice.documentId)).toMatchObject({ open_amount: "100.00", status: "open", version: 3 });
    expect(database.client.subledgerApplications).toHaveLength(1);

    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-reapply-ended"),
        idempotencyKey: "apply-payment-1001",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "60.00",
        applicationDate: "2026-08-05",
        expectedSourceVersion: 3,
        expectedTargetVersion: 3
      })
    ).rejects.toThrow("cannot be replayed as applied");
  });

  it("enforces fiscal locks for apply, unapply, and void without changing canonical state", async () => {
    const database = subledgerDatabase();
    const unrestricted = service(database);
    const invoice = await unrestricted.invoices.create({
      operation: operation("request-fiscal-invoice"),
      idempotencyKey: "fiscal-invoice",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "100.00" }]
    });
    const payment = await unrestricted.customerPayments.record({
      operation: operation("request-fiscal-payment"),
      idempotencyKey: "fiscal-payment",
      date: "2026-08-05",
      customerId: "customer_acme",
      amount: "60.00",
      cashAccount: { accountId: "acct_cash" },
      receivableAccount: { accountId: "acct_receivable" }
    });
    const enforced = enforcedService(database);

    database.client.postingLockDate = "2026-08-05";
    await expect(enforced.paymentApplications.apply({
      operation: operation("request-locked-apply"),
      idempotencyKey: "locked-apply",
      applicationType: "customer_payment_to_invoice",
      sourceDocumentId: payment.documentId,
      targetDocumentId: invoice.documentId,
      amount: "20.00",
      applicationDate: "2026-08-05",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    })).rejects.toMatchObject({ code: "fiscal_period_closed" });
    expect(database.client.subledgerApplications).toHaveLength(0);
    expect(subledgerRow(database, invoice.documentId)).toMatchObject({ open_amount: "100.00", version: 1 });
    expect(subledgerRow(database, payment.documentId)).toMatchObject({ open_amount: "60.00", version: 1 });

    delete database.client.postingLockDate;
    database.client.fiscalPeriodStatus = "closing";
    await expect(enforced.paymentApplications.apply({
      operation: operation("request-closing-apply"),
      idempotencyKey: "closing-apply",
      applicationType: "customer_payment_to_invoice",
      sourceDocumentId: payment.documentId,
      targetDocumentId: invoice.documentId,
      amount: "20.00",
      applicationDate: "2026-08-05",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    })).rejects.toMatchObject({ code: "fiscal_period_closing" });

    database.client.fiscalPeriodStatus = "open";
    const application = await enforced.paymentApplications.apply({
      operation: operation("request-open-apply"),
      idempotencyKey: "open-apply",
      applicationType: "customer_payment_to_invoice",
      sourceDocumentId: payment.documentId,
      targetDocumentId: invoice.documentId,
      amount: "20.00",
      applicationDate: "2026-08-05",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    });
    const stateBeforeBlockedEnd = structuredClone({
      applications: database.client.subledgerApplications,
      documents: database.client.subledgerDocuments,
      lifecycleEvents: [...database.client.lifecycleEvents.entries()],
      outbox: database.client.financialOutbox
    });

    database.client.fiscalPeriodStatus = "closed";
    for (const end of ["unapply", "void"] as const) {
      await expect(enforced.paymentApplications[end]({
        operation: approvedOperation(`request-locked-${end}`),
        applicationId: application.applicationId,
        effectiveDate: "2026-08-06",
        expectedVersion: 1
      })).rejects.toMatchObject({ code: "fiscal_period_closed" });
      expect({
        applications: database.client.subledgerApplications,
        documents: database.client.subledgerDocuments,
        lifecycleEvents: [...database.client.lifecycleEvents.entries()],
        outbox: database.client.financialOutbox
      }).toEqual(stateBeforeBlockedEnd);
    }
  });

  it("settles an invoice with a canonical write-off application atomically and replays without new facts", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-write-off-invoice"),
      idempotencyKey: "write-off-invoice",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "100.00" }]
    });
    const command = {
      operation: operation("request-settle-write-off"),
      idempotencyKey: "settle-write-off",
      date: "2026-08-08" as const,
      customerId: "customer_acme",
      invoiceId: invoice.documentId,
      expectedInvoiceVersion: 1,
      amount: "30.00" as const,
      balanceAccount: { accountId: "acct_receivable" as const },
      writeOffAccount: { accountId: "acct_expense" as const },
      reason: "Approved bad debt"
    };

    const settled = await financials.writeOffs.settleInvoice(command);
    const replay = await financials.writeOffs.settleInvoice(command);

    expect(settled).toMatchObject({
      status: "settled",
      writeOffVersion: 2,
      invoiceId: invoice.documentId,
      invoiceOpenAmount: "70.00",
      invoiceStatus: "partially_applied",
      invoiceVersion: 2,
      application: { status: "applied", appliedAmount: "30.00", version: 1 }
    });
    expect(replay).toEqual({
      ...settled,
      status: "already_settled",
      application: { ...settled.application, status: "already_applied" }
    });
    expect(database.client.subledgerDocuments).toHaveLength(2);
    expect(database.client.subledgerApplications).toEqual([
      expect.objectContaining({
        application_type: "write_off_to_invoice",
        source_document_id: settled.writeOffDocumentId,
        target_document_id: invoice.documentId,
        applied_amount: "30.00"
      })
    ]);
    expect(subledgerRow(database, settled.writeOffDocumentId)).toMatchObject({
      document_type: "write_off",
      open_amount: "0.00",
      status: "settled",
      version: 2
    });
    expect(database.client.financialOutbox.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      "subledger_document.write_off.posted",
      "subledger_application.applied"
    ]));
    expect(database.client.storedPostings.some((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:${settled.application.applicationId}:`)
    )).toBe(false);
  });

  it("rolls back a write-off settlement when invoice scope, balance, or version validation fails", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-write-off-validation-invoice"),
      idempotencyKey: "write-off-validation-invoice",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "10.00" }]
    });
    const base = {
      operation: operation("request-invalid-write-off"),
      date: "2026-08-08" as const,
      customerId: "customer_acme",
      invoiceId: invoice.documentId,
      expectedInvoiceVersion: 1,
      amount: "11.00" as const,
      balanceAccount: { accountId: "acct_receivable" as const },
      writeOffAccount: { accountId: "acct_expense" as const }
    };

    await expect(financials.writeOffs.settleInvoice({
      ...base,
      idempotencyKey: "write-off-over-balance"
    })).rejects.toThrow("exceeds an available document balance");
    await expect(financials.writeOffs.settleInvoice({
      ...base,
      idempotencyKey: "write-off-wrong-customer",
      customerId: "customer_other",
      amount: "5.00"
    })).rejects.toMatchObject({ code: "missing_document" });
    await expect(financials.writeOffs.settleInvoice({
      ...base,
      idempotencyKey: "write-off-stale-version",
      expectedInvoiceVersion: 2,
      amount: "5.00"
    })).rejects.toMatchObject({ code: "optimistic_concurrency_conflict" });

    expect(database.client.subledgerDocuments).toHaveLength(1);
    expect(database.client.subledgerApplications).toHaveLength(0);
    expect(subledgerRow(database, invoice.documentId)).toMatchObject({ open_amount: "10.00", status: "open", version: 1 });
  });

  it("namespaces journal persistence identities by transaction type", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const nativeJournal = await financials.journalEntries.post({
      operation: operation("request-shared-key-journal"),
      idempotencyKey: "shared-idempotency-key",
      date: "2026-08-01",
      lines: [
        { accountId: "acct_receivable", debit: "10.00" },
        { accountId: "acct_service_revenue", credit: "10.00" }
      ]
    });
    const invoice = await financials.invoices.create({
      operation: operation("request-shared-key-invoice"),
      idempotencyKey: "shared-idempotency-key",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "10.00" }]
    });

    expect(invoice.journal.transactionId).not.toBe(nativeJournal.transactionId);
    expect(invoice.journal.importBatchId).not.toBe(nativeJournal.importBatchId);
    expect(invoice.journal.postingIds).not.toEqual(nativeJournal.postingIds);
  });

  it("rejects a subledger idempotency replay when material document facts change", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const input = {
      operation: operation("request-invoice-idempotency"),
      idempotencyKey: "invoice-idempotency",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "10.00" }]
    } as const;

    await financials.invoices.create(input);
    await expect(
      financials.invoices.create({ ...input, dueDate: "2026-09-01" })
    ).rejects.toBeInstanceOf(ErpFinancialsIdempotencyConflictError);
    expect(database.client.subledgerDocuments).toHaveLength(1);
  });

  it("rejects cross-party, cross-currency, over-balance, and stale-version applications before writing", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-invoice-invariants"),
      idempotencyKey: "invoice-invariants",
      date: "2026-08-01",
      dueDate: "2026-08-31",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "100.00" }]
    });
    const payment = await financials.customerPayments.record({
      operation: operation("request-payment-invariants"),
      idempotencyKey: "payment-invariants",
      date: "2026-08-05",
      customerId: "customer_other",
      amount: "60.00",
      cashAccount: { accountId: "acct_cash" },
      receivableAccount: { accountId: "acct_receivable" }
    });

    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-cross-party"),
        idempotencyKey: "apply-cross-party",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "10.00",
        applicationDate: "2026-08-05",
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      })
    ).rejects.toThrow("same non-null party");

    subledgerRow(database, payment.documentId).party_id = "customer_acme";
    subledgerRow(database, payment.documentId).currency_code = "EUR";
    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-cross-currency"),
        idempotencyKey: "apply-cross-currency",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "10.00",
        applicationDate: "2026-08-05",
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      })
    ).rejects.toThrow("same currency");

    subledgerRow(database, payment.documentId).currency_code = "USD";
    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-over-balance"),
        idempotencyKey: "apply-over-balance",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "61.00",
        applicationDate: "2026-08-05",
        expectedSourceVersion: 1,
        expectedTargetVersion: 1
      })
    ).rejects.toThrow("exceeds an available document balance");

    await expect(
      financials.paymentApplications.apply({
        operation: operation("request-stale-version"),
        idempotencyKey: "apply-stale-version",
        applicationType: "customer_payment_to_invoice",
        sourceDocumentId: payment.documentId,
        targetDocumentId: invoice.documentId,
        amount: "10.00",
        applicationDate: "2026-08-05",
        expectedSourceVersion: 2,
        expectedTargetVersion: 1
      })
    ).rejects.toThrow("Source document version changed concurrently");
    expect(database.client.subledgerApplications).toHaveLength(0);
  });

  it("exposes atomic services for every required receivable, payable, cash, and adjustment document", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const results = [
      await financials.credits.issue({
        operation: operation("request-credit"), idempotencyKey: "credit-1", date: "2026-08-02",
        customerId: "customer_acme", amount: "10.00", revenueAccount: { accountId: "acct_service_revenue" },
        receivableAccount: { accountId: "acct_receivable" }
      }),
      await financials.refunds.issue({
        operation: operation("request-refund"), idempotencyKey: "refund-1", date: "2026-08-03",
        customerId: "customer_acme", amount: "5.00", receivableAccount: { accountId: "acct_receivable" },
        cashAccount: { accountId: "acct_cash" }
      }),
      await financials.vendorBills.create({
        operation: operation("request-bill"), idempotencyKey: "bill-1", date: "2026-08-04", dueDate: "2026-09-03",
        vendorId: "vendor_northwind", payableAccount: { accountId: "acct_payable" },
        expenseLines: [{ accountId: "acct_expense", amount: "25.00" }]
      }),
      await financials.billPayments.record({
        operation: operation("request-bill-payment"), idempotencyKey: "bill-payment-1", date: "2026-08-05",
        vendorId: "vendor_northwind", amount: "20.00", payableAccount: { accountId: "acct_payable" },
        cashAccount: { accountId: "acct_cash" }
      }),
      await financials.writeOffs.record({
        operation: operation("request-write-off"), idempotencyKey: "write-off-1", date: "2026-08-06",
        partyId: "customer_acme", amount: "7.00", balanceType: "receivable",
        balanceAccount: { accountId: "acct_receivable" }, writeOffAccount: { accountId: "acct_expense" }
      }),
      await financials.deposits.record({
        operation: operation("request-deposit"), idempotencyKey: "deposit-1", date: "2026-08-07", amount: "30.00",
        bankAccount: { accountId: "acct_cash" }, clearingAccount: { accountId: "acct_clearing" }
      }),
      await financials.transfers.record({
        operation: operation("request-transfer"), idempotencyKey: "transfer-1", date: "2026-08-08", amount: "15.00",
        fromAccount: { accountId: "acct_cash" }, toAccount: { accountId: "acct_clearing" }
      })
    ];

    expect(results.map((result) => result.documentType)).toEqual([
      "credit_memo", "refund", "vendor_bill", "bill_payment", "write_off", "deposit", "transfer"
    ]);
    expect(results.every((result) => result.status === "posted")).toBe(true);
    expect(database.client.subledgerDocuments).toHaveLength(7);
    expect(database.commits).toBe(7);

    await expect(
      financials.transfers.record({
        operation: operation("request-transfer-same-account"),
        idempotencyKey: "transfer-same-account",
        date: "2026-08-09",
        amount: "1.00",
        fromAccount: { accountId: "acct_cash" },
        toAccount: { accountId: "acct_cash" }
      })
    ).rejects.toThrow("must differ");
    expect(database.transactionCalls).toBe(7);
  });

  it("enforces versions and voids an unapplied posted vendor bill with a compensating journal", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const bill = await financials.vendorBills.create({
      operation: operation("request-bill-to-void"),
      idempotencyKey: "bill-to-void",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "25.00" }]
    });
    const command = {
      operation: approvedOperation("request-void-bill"),
      vendorBillId: bill.documentId,
      expectedVersion: 1,
      idempotencyKey: "void-bill",
      date: "2026-08-14",
      memo: "Void duplicate vendor bill"
    } as const;

    await expect(financials.vendorBills.voidPosted({ ...command, expectedVersion: 2 })).rejects.toMatchObject({
      code: "optimistic_concurrency_conflict",
      details: { actualVersion: 1, expectedVersion: 2, vendorBillId: bill.documentId }
    });

    await expect(financials.vendorBills.voidIssued(command)).resolves.toMatchObject({
      status: "voided",
      outcome: "voided",
      originalVendorBillId: bill.documentId,
      originalVersion: 2
    });
    expect(subledgerRow(database, bill.documentId)).toMatchObject({
      status: "voided",
      open_amount: "0.00",
      version: 2
    });
    await expect(financials.vendorBills.voidPosted(command)).resolves.toMatchObject({
      status: "already_voided",
      reversal: { status: "already_posted" }
    });
  });

  it("replaces an unapplied posted vendor bill and preserves vendor scope", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const bill = await financials.vendorBills.create({
      operation: operation("request-bill-to-replace"),
      idempotencyKey: "bill-to-replace",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "25.00" }]
    });
    const command = {
      operation: approvedOperation("request-replace-bill"),
      vendorBillId: bill.documentId,
      expectedVersion: 1,
      idempotencyKey: "replace-bill",
      date: "2026-08-14",
      replacement: {
        idempotencyKey: "replacement-bill",
        date: "2026-08-14" as const,
        dueDate: "2026-09-14" as const,
        documentNumber: "BILL-100-CORRECTED",
        vendorId: "vendor_northwind",
        payableAccount: { accountId: "acct_payable" },
        expenseLines: [{ accountId: "acct_expense", amount: "30.00" }]
      }
    } as const;

    await expect(financials.vendorBills.replaceIssued(command)).resolves.toMatchObject({
      status: "replaced",
      outcome: "replaced",
      originalVendorBillId: bill.documentId,
      originalVersion: 2,
      replacement: {
        documentType: "vendor_bill",
        originalAmount: "30.00",
        version: 1
      }
    });
    expect(database.client.journalLinks.map((link) => link.link_type)).toEqual(["reversal", "replacement"]);
  });

  it("voids an unapplied bill payment idempotently with version and canonical reversal guards", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const payment = await financials.billPayments.record({
      operation: operation("request-payment-to-void"),
      idempotencyKey: "payment-to-void",
      date: "2026-08-05",
      vendorId: "vendor_northwind",
      amount: "20.00",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" }
    });
    const command = {
      operation: approvedOperation("request-void-payment"),
      billPaymentId: payment.documentId,
      expectedVersion: 1,
      idempotencyKey: "void-payment",
      date: "2026-08-14",
      memo: "Void duplicate bill payment"
    } as const;

    await expect(financials.billPayments.void({ ...command, expectedVersion: 2 })).rejects.toMatchObject({
      code: "optimistic_concurrency_conflict",
      details: { actualVersion: 1, billPaymentId: payment.documentId, expectedVersion: 2 }
    });
    await expect(financials.billPayments.void(command)).resolves.toMatchObject({
      status: "voided",
      originalBillPaymentId: payment.documentId,
      originalTransactionId: payment.journal.transactionId,
      originalVersion: 2,
      reversal: { status: "posted" }
    });
    expect(subledgerRow(database, payment.documentId)).toMatchObject({
      status: "voided",
      open_amount: "0.00",
      version: 2
    });
    expect(database.client.journalLinks).toEqual([
      expect.objectContaining({
        original_transaction_id: payment.journal.transactionId,
        link_type: "void"
      })
    ]);
    await expect(financials.billPayments.voidIssued(command)).resolves.toMatchObject({
      status: "already_voided",
      reversal: { status: "already_posted" }
    });
  });

  it("requires bill-payment applications to be unapplied before voiding", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const bill = await financials.vendorBills.create({
      operation: operation("request-bill-for-payment-void-guard"),
      idempotencyKey: "bill-for-payment-void-guard",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "25.00" }]
    });
    const payment = await financials.billPayments.record({
      operation: operation("request-applied-payment"),
      idempotencyKey: "applied-payment",
      date: "2026-08-05",
      vendorId: "vendor_northwind",
      amount: "20.00",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" }
    });
    await financials.paymentApplications.apply({
      operation: operation("request-apply-payment-before-void"),
      idempotencyKey: "apply-payment-before-void",
      applicationType: "bill_payment_to_bill",
      sourceDocumentId: payment.documentId,
      targetDocumentId: bill.documentId,
      amount: "10.00",
      applicationDate: "2026-08-06",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    });

    await expect(financials.billPayments.voidPosted({
      operation: approvedOperation("request-void-applied-payment"),
      billPaymentId: payment.documentId,
      expectedVersion: 2,
      idempotencyKey: "void-applied-payment",
      date: "2026-08-14"
    })).rejects.toMatchObject({ code: "terminal_state_conflict" });
    expect(subledgerRow(database, payment.documentId)).toMatchObject({
      status: "partially_applied",
      open_amount: "10.00",
      version: 2
    });
  });

  it("records and allocates an ordered vendor disbursement atomically with payload-bound replay", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const firstBill = await financials.vendorBills.create({
      operation: operation("request-first-bill"),
      idempotencyKey: "first-bill",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "12.00" }]
    });
    const secondBill = await financials.vendorBills.create({
      operation: operation("request-second-bill"),
      idempotencyKey: "second-bill",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "8.00" }]
    });
    const command = {
      operation: operation("request-settle-bills"),
      idempotencyKey: "settle-bills",
      date: "2026-08-10" as const,
      documentNumber: "PAY-200",
      vendorId: "vendor_northwind",
      amount: "20.00",
      paymentMethod: "ach" as const,
      reference: "ACH-8871",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" },
      allocations: [
        { billId: firstBill.documentId, amount: "12.00", expectedBillVersion: 1 },
        { billId: secondBill.documentId, amount: "8.00", expectedBillVersion: 1 }
      ]
    };

    const result = await financials.billPayments.recordAndApply(command);
    expect(result).toMatchObject({
      status: "cleared",
      version: 2,
      payment: { documentStatus: "settled", openAmount: "0.00", version: 3 },
      applications: [
        { targetDocumentId: firstBill.documentId, appliedAmount: "12.00", status: "applied" },
        { targetDocumentId: secondBill.documentId, appliedAmount: "8.00", status: "applied" }
      ]
    });
    expect(database.client.billPaymentDisbursements).toEqual([
      expect.objectContaining({
        bill_payment_id: result.billPaymentId,
        payment_method: "ach",
        payment_reference: "ACH-8871",
        funding_account_id: "acct_cash",
        payable_account_id: "acct_payable",
        status: "cleared",
        version: 2
      })
    ]);
    const cashApplicationPostings = database.client.storedPostings.filter((posting) =>
      String(posting.source_posting_id).startsWith("cash-application:") &&
      String(posting.source_posting_id).includes(":recognize:")
    );
    expect(cashApplicationPostings).toHaveLength(4);
    expect(cashApplicationPostings.filter((posting) => posting.account_id === "acct_expense").map(
      (posting) => posting.debit_amount
    ).sort()).toEqual(["12.00", "8.00"]);
    await expect(financials.billPayments.recordAndApply(command)).resolves.toMatchObject({
      status: "already_cleared",
      billPaymentId: result.billPaymentId
    });
    expect(database.client.subledgerApplications).toHaveLength(2);

    await expect(financials.billPayments.recordAndApply({
      ...command,
      reference: "ACH-DIFFERENT"
    })).rejects.toBeInstanceOf(ErpFinancialsIdempotencyConflictError);
  });

  it("rolls back the complete disbursement when any ordered allocation is ineligible", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const firstBill = await financials.vendorBills.create({
      operation: operation("request-atomic-bill-1"), idempotencyKey: "atomic-bill-1", date: "2026-08-04",
      dueDate: "2026-09-03", vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "12.00" }]
    });
    const wrongVendorBill = await financials.vendorBills.create({
      operation: operation("request-atomic-bill-2"), idempotencyKey: "atomic-bill-2", date: "2026-08-04",
      dueDate: "2026-09-03", vendorId: "vendor_other",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "8.00" }]
    });

    await expect(financials.billPayments.recordAndApply({
      operation: operation("request-invalid-atomic-disbursement"),
      idempotencyKey: "invalid-atomic-disbursement",
      date: "2026-08-10",
      vendorId: "vendor_northwind",
      amount: "20.00",
      paymentMethod: "ach",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" },
      allocations: [
        { billId: firstBill.documentId, amount: "12.00", expectedBillVersion: 1 },
        { billId: wrongVendorBill.documentId, amount: "8.00", expectedBillVersion: 1 }
      ]
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(database.client.billPaymentDisbursements).toHaveLength(0);
    expect(database.client.subledgerApplications).toHaveLength(0);
    expect(database.client.subledgerDocuments).toHaveLength(2);
    expect(database.rollbacks).toBe(1);
  });

  it("schedules, clears, and atomically compensates an applied bill payment", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const bill = await financials.vendorBills.create({
      operation: operation("request-scheduled-bill"),
      idempotencyKey: "scheduled-bill",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "20.00" }]
    });
    const scheduled = await financials.billPayments.schedule({
      operation: operation("request-schedule-payment"),
      idempotencyKey: "scheduled-payment",
      date: "2026-08-10",
      vendorId: "vendor_northwind",
      amount: "20.00",
      paymentMethod: "check",
      reference: "1042",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" },
      allocations: [{ billId: bill.documentId, amount: "20.00", expectedBillVersion: 1 }]
    });
    expect(scheduled).toMatchObject({ status: "scheduled", version: 1 });
    expect(database.client.subledgerDocuments).toHaveLength(1);

    const cleared = await financials.billPayments.clear({
      operation: operation("request-clear-payment"),
      billPaymentId: scheduled.billPaymentId,
      expectedVersion: 1,
      idempotencyKey: "clear-scheduled-payment"
    });
    expect(cleared).toMatchObject({ status: "cleared", version: 2 });
    expect(subledgerRow(database, bill.documentId)).toMatchObject({ status: "settled", open_amount: "0.00" });

    const compensated = await financials.billPayments.voidAndUnapply({
      operation: approvedOperation("request-compensate-payment"),
      billPaymentId: scheduled.billPaymentId,
      expectedVersion: 2,
      idempotencyKey: "compensate-scheduled-payment",
      date: "2026-08-14",
      memo: "Cancelled check"
    });
    expect(compensated).toMatchObject({
      status: "voided",
      disbursementVersion: 3,
      endedApplications: [{ status: "voided" }]
    });
    expect(subledgerRow(database, bill.documentId)).toMatchObject({ status: "open", open_amount: "20.00" });
    expect(subledgerRow(database, scheduled.billPaymentId)).toMatchObject({ status: "voided", open_amount: "0.00" });
    expect(database.client.billPaymentDisbursements[0]).toMatchObject({ status: "voided", version: 3 });
  });

  it("cancels a scheduled bill payment optimistically and idempotently without posting", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const bill = await financials.vendorBills.create({
      operation: operation("request-cancel-bill"),
      idempotencyKey: "cancel-bill",
      date: "2026-08-04",
      dueDate: "2026-09-03",
      vendorId: "vendor_northwind",
      payableAccount: { accountId: "acct_payable" },
      expenseLines: [{ accountId: "acct_expense", amount: "20.00" }]
    });
    const scheduled = await financials.billPayments.schedule({
      operation: operation("request-schedule-cancelled-payment"),
      idempotencyKey: "cancelled-payment",
      date: "2026-08-20",
      vendorId: "vendor_northwind",
      amount: "20.00",
      paymentMethod: "card",
      reference: "CARD-200",
      payableAccount: { accountId: "acct_payable" },
      cashAccount: { accountId: "acct_cash" },
      allocations: [{ billId: bill.documentId, amount: "20.00", expectedBillVersion: 1 }]
    });
    const command = {
      operation: approvedOperation("request-cancel-scheduled-payment"),
      billPaymentId: scheduled.billPaymentId,
      expectedVersion: 1,
      idempotencyKey: "cancel-scheduled-payment"
    } as const;
    await expect(financials.billPayments.cancel(command)).resolves.toMatchObject({ status: "voided", version: 2 });
    await expect(financials.billPayments.cancel(command)).resolves.toMatchObject({ status: "already_voided", version: 2 });
    expect(database.client.subledgerDocuments).toHaveLength(1);
    expect(database.client.billPaymentDisbursements[0]).toMatchObject({
      status: "voided",
      subledger_document_id: null,
      version: 2
    });
  });

  it("voids an unapplied issued credit through one compensating canonical lifecycle", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const credit = await financials.credits.issue({
      operation: operation("request-credit-to-void"),
      idempotencyKey: "credit-to-void",
      date: "2026-08-02",
      customerId: "customer_acme",
      amount: "10.00",
      revenueAccount: { accountId: "acct_service_revenue" },
      receivableAccount: { accountId: "acct_receivable" }
    });
    const command = {
      operation: approvedOperation("request-void-credit"),
      adjustmentDocumentId: credit.documentId,
      expectedVersion: 1,
      idempotencyKey: "void-credit",
      date: "2026-08-14",
      memo: "Void duplicate credit"
    } as const;

    const result = await financials.credits.voidIssued(command);
    expect(result).toMatchObject({
      status: "voided",
      outcome: "voided",
      adjustmentType: "credit",
      originalAdjustmentDocumentId: credit.documentId,
      originalVersion: 2
    });
    expect(subledgerRow(database, credit.documentId)).toMatchObject({
      status: "voided",
      open_amount: "0.00",
      version: 2
    });
    expect(database.client.journalLinks).toEqual([
      expect.objectContaining({
        original_transaction_id: credit.journal.transactionId,
        related_transaction_id: result.reversal.transactionId,
        link_type: "void"
      })
    ]);

    await expect(financials.adjustments.voidIssued({ ...command, adjustmentType: "credit" })).resolves.toMatchObject({
      status: "already_voided",
      originalVersion: 2,
      reversal: { status: "already_posted" }
    });
    expect(database.client.journalLinks).toHaveLength(2);
    expect(new Set(database.client.journalLinks.map((link) => link.journal_entry_link_id)).size).toBe(1);
  });

  it("replaces an issued refund with a linked refund while preserving one ledger", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const refund = await financials.refunds.issue({
      operation: operation("request-refund-to-replace"),
      idempotencyKey: "refund-to-replace",
      date: "2026-08-03",
      customerId: "customer_acme",
      amount: "5.00",
      receivableAccount: { accountId: "acct_receivable" },
      cashAccount: { accountId: "acct_cash" }
    });

    const result = await financials.refunds.replaceIssued({
      operation: approvedOperation("request-replace-refund"),
      adjustmentDocumentId: refund.documentId,
      expectedVersion: 1,
      idempotencyKey: "replace-refund",
      date: "2026-08-14",
      replacement: {
        idempotencyKey: "replacement-refund",
        date: "2026-08-14",
        customerId: "customer_acme",
        amount: "7.00",
        receivableAccount: { accountId: "acct_receivable" },
        cashAccount: { accountId: "acct_cash" }
      }
    });

    expect(result).toMatchObject({
      status: "replaced",
      outcome: "replaced",
      adjustmentType: "refund",
      originalVersion: 2,
      replacement: {
        documentType: "refund",
        originalAmount: "7.00",
        documentStatus: "settled"
      }
    });
    expect(subledgerRow(database, refund.documentId)).toMatchObject({ status: "voided", version: 2 });
    expect(database.client.journalLinks.map((link) => link.link_type)).toEqual(["reversal", "replacement"]);
  });

  it("reverses recognized cash revenue for an invoice-linked refund and restores it on void", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-refund-invoice"), idempotencyKey: "refund-invoice", date: "2026-08-01", dueDate: "2026-08-31",
      customerId: "customer_acme", receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "100.00" }]
    });
    const refund = await financials.refunds.issue({
      operation: operation("request-related-refund"), idempotencyKey: "related-refund", date: "2026-08-10",
      customerId: "customer_acme", amount: "20.00", receivableAccount: { accountId: "acct_receivable" },
      cashAccount: { accountId: "acct_cash" }, relatedInvoiceId: invoice.documentId
    });
    expect(database.client.storedPostings.filter((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:refund:${refund.documentId}:reverse:`)
    )).toHaveLength(2);

    await financials.refunds.voidIssued({
      operation: approvedOperation("request-related-refund-void"), adjustmentDocumentId: refund.documentId,
      expectedVersion: 1, idempotencyKey: "related-refund-void", date: "2026-08-11"
    });
    expect(database.client.storedPostings.filter((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:refund:${refund.documentId}:recognize:`)
    )).toHaveLength(2);
  });

  it("voids a posted write-off through an approved compensating lifecycle", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const writeOff = await financials.writeOffs.record({
      operation: operation("request-write-off-to-void"),
      idempotencyKey: "write-off-to-void",
      date: "2026-08-03",
      partyId: "customer_acme",
      amount: "9.00",
      balanceType: "receivable",
      balanceAccount: { accountId: "acct_receivable" },
      writeOffAccount: { accountId: "acct_expense" },
      reason: "Duplicate write-off"
    });

    const result = await financials.writeOffs.voidIssued({
      operation: approvedOperation("request-void-write-off"),
      writeOffDocumentId: writeOff.documentId,
      expectedVersion: 1,
      idempotencyKey: "void-write-off",
      date: "2026-08-14",
      memo: "Reverse duplicate write-off"
    });

    expect(result).toMatchObject({
      status: "voided",
      adjustmentType: "write_off",
      originalAdjustmentDocumentId: writeOff.documentId,
      originalVersion: 2
    });
    expect(subledgerRow(database, writeOff.documentId)).toMatchObject({ status: "voided", version: 2 });
    expect(database.client.journalLinks).toEqual([
      expect.objectContaining({ original_transaction_id: writeOff.journal.transactionId, link_type: "void" })
    ]);
  });

  it("rejects voiding a credit while it has an active application", async () => {
    const database = subledgerDatabase();
    const financials = service(database);
    const invoice = await financials.invoices.create({
      operation: operation("request-credit-void-invoice"),
      idempotencyKey: "credit-void-invoice",
      date: "2026-08-02",
      dueDate: "2026-09-02",
      customerId: "customer_acme",
      receivableAccount: { accountId: "acct_receivable" },
      revenueLines: [{ accountId: "acct_service_revenue", amount: "20.00" }]
    });
    const credit = await financials.credits.issue({
      operation: operation("request-applied-credit"),
      idempotencyKey: "applied-credit",
      date: "2026-08-03",
      customerId: "customer_acme",
      amount: "10.00",
      revenueAccount: { accountId: "acct_service_revenue" },
      receivableAccount: { accountId: "acct_receivable" }
    });
    const application = await financials.paymentApplications.apply({
      operation: operation("request-apply-credit-before-void"),
      idempotencyKey: "apply-credit-before-void",
      applicationType: "credit_to_invoice",
      sourceDocumentId: credit.documentId,
      targetDocumentId: invoice.documentId,
      amount: "5.00",
      applicationDate: "2026-08-04",
      expectedSourceVersion: 1,
      expectedTargetVersion: 1
    });
    expect(database.client.storedPostings.some((posting) =>
      String(posting.source_posting_id).startsWith(`cash-application:${application.applicationId}:`)
    )).toBe(false);

    await expect(financials.credits.voidIssued({
      operation: approvedOperation("request-void-applied-credit"),
      adjustmentDocumentId: credit.documentId,
      expectedVersion: 2,
      idempotencyKey: "void-applied-credit",
      date: "2026-08-14"
    })).rejects.toMatchObject({ code: "terminal_state_conflict" });
    expect(subledgerRow(database, credit.documentId)).toMatchObject({ status: "partially_applied", version: 2 });
  });

  it("rejects duplicate account identities before writing a hierarchy", async () => {
    const database = new ServiceTestDatabase();
    const financials = service(database);

    await expect(
      financials.accounts.upsertTree({
        operation: operation("request-duplicate-account"),
        parent: {
          accountId: "acct_service_revenue",
          name: "Service Revenue",
          classification: "income"
        },
        children: [
          {
            accountId: "acct_service_revenue",
            name: "Duplicate",
            classification: "income"
          }
        ]
      })
    ).rejects.toBeInstanceOf(ErpFinancialsValidationError);

    expect(database.transactionCalls).toBe(0);
  });
});

function service(database: ErpFinancialsTransactionRunner) {
  return createErpFinancials({
    database,
    tenantId: "tenant_service",
    companyId: "company_service",
    sourceId: "source_service",
    currencyCode: "USD",
    accountingBasis: "accrual",
    postingPolicy: "legacy_unrestricted",
    now: () => "2026-08-12T15:00:00.000Z"
  });
}

function enforcedService(database: ErpFinancialsTransactionRunner) {
  return createErpFinancials({
    database,
    tenantId: "tenant_service",
    companyId: "company_service",
    sourceId: "source_service",
    currencyCode: "USD",
    accountingBasis: "accrual",
    postingPolicy: "enforce_fiscal_periods",
    now: () => "2026-08-12T15:00:00.000Z"
  });
}

function reclassificationEntry(): PostJournalEntryInput {
  return {
    operation: operation("request-journal-reclass"),
    idempotencyKey: "service-revenue-reclass-2026-08",
    date: "2026-08-12",
    memo: "Break out service revenue",
    lines: [
      { accountId: "acct_service_revenue", debit: "100.00" },
      { accountId: "acct_setup_fee", credit: "30.00" },
      { accountId: "acct_access_fee", credit: "70.00" }
    ]
  };
}

function operation(requestId: string) {
  return {
    actorRef: "user:ray",
    requestId,
    correlationId: "correlation:erp-service-test",
    reasonCode: "test_financial_operation",
    occurredAt: "2026-08-12T14:59:00.000Z"
  } as const;
}

function approvedOperation(requestId: string) {
  return { ...operation(requestId), approverRef: "user:controller" } as const;
}

function subledgerDatabase(): ServiceTestDatabase {
  return new ServiceTestDatabase([
    accountRow("acct_receivable", true),
    accountRow("acct_payable", true),
    accountRow("acct_cash", true),
    accountRow("acct_clearing", true),
    accountRow("acct_expense", true),
    accountRow("acct_service_revenue", true),
    accountRow("acct_access_fee", true)
  ]);
}

function subledgerRow(database: ServiceTestDatabase, documentId: string): Record<string, unknown> {
  const row = database.client.subledgerDocuments.find((document) => document.subledger_document_id === documentId);
  if (row === undefined) {
    throw new Error(`Missing subledger test document ${documentId}`);
  }
  return row;
}

function accountRow(accountId: string, active: boolean): Record<string, unknown> {
  return {
    account_id: accountId,
    tenant_id: "tenant_service",
    source_id: "source_service",
    source_account_id: accountId,
    account_number: null,
    name: accountId,
    type: "income",
    subtype: null,
    classification: "income",
    parent_account_id: accountId === "acct_service_revenue" ? null : "acct_service_revenue",
    currency_code: "USD",
    active
  };
}

class ServiceTestDatabase implements ErpFinancialsTransactionRunner {
  readonly client: ServiceTestClient;
  transactionCalls = 0;
  commits = 0;
  rollbacks = 0;

  constructor(accounts: readonly Record<string, unknown>[] = []) {
    this.client = new ServiceTestClient(accounts);
  }

  async transaction<Result>(operation: (client: PostgresQueryClient) => Promise<Result>): Promise<Result> {
    this.transactionCalls += 1;
    const before = this.client.snapshot();
    try {
      const result = await operation(this.client);
      this.commits += 1;
      return result;
    } catch (error) {
      this.client.restore(before);
      this.rollbacks += 1;
      throw error;
    }
  }
}

class ServiceTestClient implements PostgresQueryClient {
  readonly calls: QueryCall[] = [];
  readonly accounts: Record<string, unknown>[];
  readonly storedJournals = new Map<string, StoredJournal & Record<string, unknown>>();
  storedPostings: Record<string, unknown>[] = [];
  journalLinks: Record<string, unknown>[] = [];
  subledgerDocuments: Record<string, unknown>[] = [];
  subledgerApplications: Record<string, unknown>[] = [];
  billPaymentDisbursements: Record<string, unknown>[] = [];
  financialOutbox: Record<string, unknown>[] = [];
  readonly lifecycleEvents = new Map<string, Record<string, unknown>>();
  postingLockDate?: string;
  fiscalPeriodStatus: "open" | "closing" | "closed" = "open";
  failInsertTable?: string;

  constructor(accounts: readonly Record<string, unknown>[]) {
    this.accounts = [...accounts];
  }

  snapshot() {
    return {
      accounts: structuredClone(this.accounts),
      storedJournals: structuredClone([...this.storedJournals.entries()]),
      storedPostings: structuredClone(this.storedPostings),
      lifecycleEvents: structuredClone([...this.lifecycleEvents.entries()]),
      journalLinks: structuredClone(this.journalLinks),
      subledgerDocuments: structuredClone(this.subledgerDocuments),
      subledgerApplications: structuredClone(this.subledgerApplications),
      billPaymentDisbursements: structuredClone(this.billPaymentDisbursements),
      financialOutbox: structuredClone(this.financialOutbox)
    };
  }

  restore(snapshot: ReturnType<ServiceTestClient["snapshot"]>): void {
    this.accounts.splice(0, this.accounts.length, ...snapshot.accounts);
    this.storedJournals.clear();
    snapshot.storedJournals.forEach(([key, value]) => this.storedJournals.set(key, value));
    this.storedPostings = snapshot.storedPostings;
    this.lifecycleEvents.clear();
    snapshot.lifecycleEvents.forEach(([key, value]) => this.lifecycleEvents.set(key, value));
    this.journalLinks = snapshot.journalLinks;
    this.subledgerDocuments = snapshot.subledgerDocuments;
    this.subledgerApplications = snapshot.subledgerApplications;
    this.billPaymentDisbursements = snapshot.billPaymentDisbursements;
    this.financialOutbox = snapshot.financialOutbox;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });

    if (sql.includes('from "erp_financials"."company_sources"')) {
      return Promise.resolve({ rows: [{ company_source_id: "company_source_service" }] as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."accounting_book_controls"')) {
      return Promise.resolve({
        rows: [{ posting_lock_date: this.postingLockDate ?? null }] as unknown as readonly Row[]
      });
    }

    if (sql.includes('from "erp_financials"."fiscal_periods"')) {
      return Promise.resolve({
        rows: [{ fiscal_period_id: "period_2026_08", status: this.fiscalPeriodStatus }] as unknown as readonly Row[]
      });
    }

    if (sql.includes('insert into "erp_financials"."financial_outbox"')) {
      const row: Record<string, unknown> = {
        outbox_event_id: params[0],
        tenant_id: params[1],
        company_id: params[2],
        book_id: params[3] ?? null,
        source_id: params[4],
        event_type: params[5],
        aggregate_type: params[6],
        aggregate_id: params[7],
        idempotency_key: params[8],
        payload: params[9],
        status: "pending",
        attempt_count: 0,
        available_at: params[10],
        lease_expires_at: null,
        last_error: null,
        created_at: params[10],
        published_at: null
      };
      const existing = this.financialOutbox.find(
        (event) =>
          event.tenant_id === row.tenant_id &&
          event.company_id === row.company_id &&
          event.source_id === row.source_id &&
          event.idempotency_key === row.idempotency_key
      );
      if (existing !== undefined) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.financialOutbox.push(row);
      return Promise.resolve({ rows: [{ outbox_event_id: row.outbox_event_id }] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('from "erp_financials"."financial_outbox"')) {
      const row = this.financialOutbox.find(
        (event) =>
          event.tenant_id === params[0] &&
          event.company_id === params[1] &&
          event.source_id === params[2] &&
          event.idempotency_key === params[3]
      );
      return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."parties"')) {
      const partyId = String(params[2]);
      return Promise.resolve({
        rows: [
          {
            party_id: partyId,
            party_type: partyId.includes("vendor") ? "vendor" : "customer",
            active: true
          }
        ] as unknown as readonly Row[]
      });
    }

    if (sql.includes('insert into "erp_financials"."bill_payment_disbursements"')) {
      const row: Record<string, unknown> = {
        bill_payment_id: params[0],
        tenant_id: params[1],
        company_id: params[2],
        source_id: params[3],
        subledger_document_id: null,
        vendor_id: params[4],
        payment_date: params[5],
        document_number: params[6] ?? null,
        memo: params[7] ?? null,
        currency_code: params[8],
        amount: params[9],
        payment_method: params[10],
        payment_reference: params[11] ?? null,
        funding_account_id: params[12],
        payable_account_id: params[13],
        allocations: params[14],
        status: "scheduled",
        version: 1,
        idempotency_key: params[15],
        payload_checksum: params[16],
        scheduled_event_id: params[17],
        cleared_event_id: null,
        voided_event_id: null,
        created_at: params[18],
        updated_at: params[18]
      };
      this.billPaymentDisbursements.push(row);
      return Promise.resolve({ rows: [row] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('from "erp_financials"."bill_payment_disbursements"')) {
      const row = sql.includes('"idempotency_key" = $4')
        ? this.billPaymentDisbursements.find((payment) => payment.idempotency_key === params[3])
        : this.billPaymentDisbursements.find((payment) => payment.bill_payment_id === params[3]);
      return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
    }

    if (sql.startsWith('update "erp_financials"."bill_payment_disbursements"')) {
      const row = this.billPaymentDisbursements.find((payment) => payment.bill_payment_id === params[3]);
      const clearing = sql.includes('set "status" = \'cleared\'');
      const expectedVersion = params[clearing ? 7 : 6];
      if (row === undefined || row.version !== expectedVersion) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (clearing) {
        row.status = "cleared";
        row.subledger_document_id = params[4];
        row.cleared_event_id = params[5];
        row.updated_at = params[6];
      } else {
        row.status = "voided";
        row.voided_event_id = params[4];
        row.updated_at = params[5];
      }
      row.version = Number(row.version) + 1;
      return Promise.resolve({ rows: [{ version: row.version }] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('from "erp_financials"."subledger_documents"')) {
      if (sql.includes('"idempotency_key" = $4')) {
        const row = this.subledgerDocuments.find((document) => document.idempotency_key === params[3]);
        return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
      }
      const ids = params[3];
      let rows = Array.isArray(ids)
        ? this.subledgerDocuments.filter((document) => ids.includes(document.subledger_document_id))
        : this.subledgerDocuments.filter((document) => document.subledger_document_id === ids);
      if (sql.includes('"document_type" = \'invoice\'') && params[4] !== undefined) {
        rows = rows.filter((document) => document.document_type === "invoice" && document.party_id === params[4]);
      }
      return Promise.resolve({ rows: rows as unknown as readonly Row[] });
    }

    if (sql.startsWith('update "erp_financials"."subledger_documents"')) {
      const row = this.subledgerDocuments.find((document) => document.subledger_document_id === params[3]);
      if (row === undefined || row.version !== params[5]) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      row.open_amount = "0.00";
      row.status = "voided";
      row.version = Number(row.version) + 1;
      row.updated_at = params[4];
      return Promise.resolve({ rows: [{ version: row.version }] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('insert into "erp_financials"."subledger_documents"')) {
      const row: Record<string, unknown> = {
        subledger_document_id: params[0],
        tenant_id: params[1],
        company_id: params[2],
        source_id: params[3],
        document_type: params[4],
        transaction_id: params[5],
        party_id: params[6],
        document_number: params[7],
        document_date: params[8],
        due_date: params[9],
        currency_code: params[10],
        original_amount: params[11],
        open_amount: params[12],
        status: params[13],
        version: 1,
        idempotency_key: params[14],
        lifecycle_event_id: params[15],
        metadata: params[16],
        created_at: params[17],
        updated_at: params[17]
      };
      const existing = this.subledgerDocuments.find((document) => document.idempotency_key === row.idempotency_key);
      if (existing !== undefined) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.subledgerDocuments.push(row);
      return Promise.resolve({ rows: [row] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('from "erp_financials"."subledger_applications"')) {
      const rows = sql.includes('"source_document_id" = $4')
        ? this.subledgerApplications.filter((application) => application.source_document_id === params[3])
        : [sql.includes('"idempotency_key" = $4')
            ? this.subledgerApplications.find((application) => application.idempotency_key === params[3])
            : this.subledgerApplications.find((application) => application.subledger_application_id === params[3])]
            .filter((row): row is Record<string, unknown> => row !== undefined);
      return Promise.resolve({ rows: rows as unknown as readonly Row[] });
    }

    if (sql.includes('insert into "erp_financials"."subledger_applications"')) {
      const row: Record<string, unknown> = {
        subledger_application_id: params[0],
        tenant_id: params[1],
        company_id: params[2],
        source_id: params[3],
        application_type: params[4],
        source_document_id: params[5],
        target_document_id: params[6],
        applied_amount: params[7],
        currency_code: params[8],
        application_date: params[9],
        status: "applied",
        version: 1,
        idempotency_key: params[10],
        applied_event_id: params[11],
        ended_event_id: null,
        created_at: params[12],
        updated_at: params[12]
      };
      this.subledgerApplications.push(row);
      this.changeSubledgerBalances(row, -1);
      return Promise.resolve({ rows: [row] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.startsWith('update "erp_financials"."subledger_applications"')) {
      const row = this.subledgerApplications.find((application) => application.subledger_application_id === params[3]);
      if (row === undefined || row.version !== params[7] || row.status !== "applied") {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      row.status = params[4];
      row.version = Number(row.version) + 1;
      row.ended_event_id = params[5];
      row.updated_at = params[6];
      this.changeSubledgerBalances(row, 1);
      return Promise.resolve({ rows: [row] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('insert into "erp_financials"."financial_lifecycle_events"')) {
      const idempotencyKey = String(params[15]);
      if (this.lifecycleEvents.has(idempotencyKey)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const row = {
        event_id: params[0],
        idempotency_key: idempotencyKey,
        aggregate_type: params[4],
        aggregate_id: params[5],
        event_type: params[6],
        actor_ref: params[7],
        approver_ref: params[8] ?? null,
        request_id: params[9],
        correlation_id: params[10],
        reason_code: params[11],
        reason_detail: params[12] ?? null,
        occurred_at: params[13],
        payload_checksum: params[16],
        prior_event_id: params[18] ?? null
      };
      this.lifecycleEvents.set(idempotencyKey, row);
      return Promise.resolve({ rows: [row] as unknown as readonly Row[], rowCount: 1 });
    }

    if (sql.includes('from "erp_financials"."financial_lifecycle_events"')) {
      if (sql.includes('select "idempotency_key"')) {
        const row = [...this.lifecycleEvents.values()].find((event) => event.event_id === params[3]);
        return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
      }
      const row = sql.includes('"aggregate_type" = \'journal_entry\'')
        ? [...this.lifecycleEvents.values()].find((event) => event.aggregate_id === params[3])
        : this.lifecycleEvents.get(String(params[3]));
      return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."journal_entry_links"')) {
      const linkTypes = Array.isArray(params[4]) ? params[4] : [];
      const row = this.journalLinks.find(
        (link) => link.original_transaction_id === params[3] && linkTypes.includes(link.link_type)
      );
      return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."accounts"')) {
      const requestedIds = params[2];
      const rows = Array.isArray(requestedIds)
        ? this.accounts.filter((account) => requestedIds.includes(account.account_id))
        : this.accounts;
      return Promise.resolve({ rows: rows as readonly Row[] });
    }

    if (sql.includes('join "erp_financials"."ledger_postings"')) {
      const transaction = [...this.storedJournals.values()].find((row) => row.transaction_id === params[2]);
      const rows =
        transaction === undefined
          ? []
          : this.storedPostings
              .filter((posting) => posting.transaction_id === transaction.transaction_id)
              .map((posting) => ({ ...transaction, ...posting, source_payload_ref: transaction.source_payload_ref }));
      return Promise.resolve({ rows: rows as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."ledger_postings"')) {
      const rows = this.storedPostings.filter(
        (posting) => posting.transaction_id === params[2] && posting.accounting_basis === "accrual"
      );
      return Promise.resolve({ rows: rows as unknown as readonly Row[] });
    }

    if (sql.includes('from "erp_financials"."transactions"') && sql.includes("for update")) {
      const stored = this.storedJournals.get(`${String(params[3])}:${String(params[2])}`);
      const rows = stored === undefined ? [] : [stored];
      return Promise.resolve({ rows: rows as unknown as readonly Row[] });
    }

    if (this.failInsertTable !== undefined && sql.includes(`insert into "erp_financials"."${this.failInsertTable}"`)) {
      return Promise.reject(new Error("simulated ledger write failure"));
    }

    if (sql.includes('insert into "erp_financials"."transactions"')) {
      const row = insertedRows({ sql, params })[0];
      if (row !== undefined) {
        this.storedJournals.set(`${String(row.source_transaction_type)}:${String(row.source_transaction_id)}`, {
          ...row,
          transaction_id: String(row.transaction_id),
          status: String(row.status),
          source_payload_ref: row.source_payload_ref
        });
      }
    }

    if (sql.includes('insert into "erp_financials"."ledger_postings"')) {
      this.storedPostings.push(...insertedRows({ sql, params }));
    }

    if (sql.includes('insert into "erp_financials"."journal_entry_links"')) {
      this.journalLinks.push(...insertedRows({ sql, params }));
    }

    if (sql.includes('insert into "erp_financials"."accounts"')) {
      this.accounts.push(...insertedRows({ sql, params }));
    }

    if (sql.includes('update "erp_financials"."report_snapshots"')) {
      return Promise.resolve({ rows: [], rowCount: 2 });
    }

    return Promise.resolve({ rows: [] });
  }

  private changeSubledgerBalances(application: Record<string, unknown>, direction: 1 | -1): void {
    const amount = Number(application.applied_amount) * direction;
    for (const id of [application.source_document_id, application.target_document_id]) {
      const document = this.subledgerDocuments.find((candidate) => candidate.subledger_document_id === id);
      if (document === undefined) {
        throw new Error("test subledger document is missing");
      }
      const openAmount = Number(document.open_amount) + amount;
      document.open_amount = openAmount.toFixed(2);
      document.version = Number(document.version) + 1;
      document.status =
        openAmount === 0
          ? "settled"
          : openAmount === Number(document.original_amount)
            ? "open"
            : "partially_applied";
    }
  }
}

class PoolTransactionClient implements ErpFinancialsPostgresTransactionClient {
  readonly sql: string[] = [];
  releaseCalls = 0;

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(sql);
    return Promise.resolve({ rows: [] });
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

function requiredCall(calls: readonly QueryCall[], sqlFragment: string): QueryCall {
  const call = calls.find((candidate) => candidate.sql.includes(sqlFragment));
  if (call === undefined) {
    throw new Error(`Missing SQL call containing ${sqlFragment}`);
  }
  return call;
}

function insertedRows(call: QueryCall): readonly Record<string, unknown>[] {
  const columnMatch = /^insert into [^(]+\(([^)]+)\)/.exec(call.sql);
  if (columnMatch?.[1] === undefined) {
    throw new Error("Expected insert SQL with a column list");
  }
  const columns = columnMatch[1].split(",").map((column) => column.trim().replaceAll('"', ""));
  const rows: Record<string, unknown>[] = [];

  for (let offset = 0; offset < call.params.length; offset += columns.length) {
    rows.push(Object.fromEntries(columns.map((column, index) => [column, call.params[offset + index]])));
  }
  return rows;
}
