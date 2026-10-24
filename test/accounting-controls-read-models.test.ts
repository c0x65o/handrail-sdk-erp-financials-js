import { describe, expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

describe("accounting-control public read models", () => {
  it("lists bounded book-scoped journals with canonical lifecycle state and filter-bound cursors", async () => {
    const client = new AccountingControlsClient();
    const reads = readModels(client);

    const first = await reads.listJournalEntries({
      sourceId: "source_1",
      status: "corrected",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      preparerRef: "user:preparer",
      limit: 1
    });

    expect(first.items[0]).toMatchObject({
      journalEntryId: "journal_2",
      originalTransactionId: "journal_2",
      status: "corrected",
      totalDebit: "125.50",
      totalCredit: "125.50",
      lineCount: 2,
      version: 3
    });
    expect(first.items[0]?.sourceProvenance).toMatchObject({ sourceId: "source_1", sourceRole: "active" });
    expect(first.items[0]?.preparerProvenance).toMatchObject({ actorRef: "user:preparer", requestId: "request-post" });
    const cursor = first.nextCursor;
    expect(typeof cursor).toBe("string");
    if (cursor === undefined) throw new Error("Expected a next journal cursor");
    expect(client.journalListSql).toContain('join "erp_financials"."reporting_book_sources"');
    expect(client.journalListSql).toContain('order by journal."transaction_date" desc, "journal_entry_id" desc');
    expect(client.journalListParams.slice(0, 12)).toEqual([
      "tenant_1", "company_1", "book_1", "accrual", "USD", "source_1", "corrected",
      "2026-08-01", "2026-08-31", undefined, "user:preparer", undefined
    ]);

    await expect(reads.listJournalEntries({
      sourceId: "source_1",
      status: "posted",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      cursor
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns exact balanced journal lines, account references, provenance, and immutable links", async () => {
    const reads = readModels(new AccountingControlsClient());

    const detail = await reads.getJournalEntry("journal_2");

    expect(detail).toMatchObject({
      journalEntryId: "journal_2",
      originalTransactionId: "journal_2",
      totalDebit: "125.50",
      totalCredit: "125.50"
    });
    expect(detail.lines[0]).toMatchObject({ transactionLineId: "line_1", debitAmount: "125.50", creditAmount: "0.00" });
    expect(detail.lines[0]?.account).toMatchObject({
      accountId: "cash", sourceAccountId: "source-cash", bookAccountKey: "cash", accountName: "Cash"
    });
    expect(detail.lines[1]).toMatchObject({ transactionLineId: "line_2", debitAmount: "0.00", creditAmount: "125.50" });
    expect(detail.lifecycle[0]).toMatchObject({ eventType: "journal_entry.posted" });
    expect(detail.links[0]).toMatchObject({
      linkType: "correction", originalTransactionId: "journal_2", relatedTransactionId: "journal_3"
    });
    expect(detail.links[0]?.lifecycle).toMatchObject({ eventType: "journal_entry.corrected" });
  });

  it("reads source-scoped fiscal periods, canonical close evidence, and the current posting lock", async () => {
    const client = new AccountingControlsClient();
    const reads = readModels(client);

    const periods = await reads.listFiscalPeriods({ sourceId: "source_1", status: "closed", fiscalYear: 2026, limit: 25 });
    expect(periods.items[0]).toMatchObject({
      fiscalPeriodId: "period_2026_08",
      sourceId: "source_1",
      status: "closed",
      version: 3,
      closeEvidence: {
        trialBalanceSnapshotId: "trial_balance_1",
        reconciliationRefs: ["reconciliation_1"],
        checklistRef: "checklist_1",
        postingMaxUpdatedAt: "2026-08-31T23:00:00.000Z",
        evidenceChecksum: "e".repeat(64)
      }
    });
    expect(periods.items[0]?.closeLifecycle).toMatchObject({ actorRef: "user:closer", approverRef: "user:controller" });
    expect(periods.items[0]?.latestLifecycle).toMatchObject({ eventType: "fiscal_period.closed" });
    expect(client.fiscalParams).toEqual([
      "tenant_1", "company_1", "book_1", "source_1", "closed", 2026, undefined, undefined, 26
    ]);

    await expect(reads.getFiscalPeriod("source_1", "period_2026_08")).resolves.toMatchObject({
      fiscalPeriodId: "period_2026_08",
      version: 3,
      status: "closed"
    });
    const postingLock = await reads.getPostingLock("source_1");
    expect(postingLock).toMatchObject({
      sourceId: "source_1",
      postingLockDate: "2026-08-31",
      version: 4
    });
    expect(postingLock.lifecycle).toMatchObject({
      eventType: "accounting_book.posting_lock_changed", requestId: "request-lock"
    });
  });

  it("returns version zero when a book source has no posting-lock control yet", async () => {
    const client = new AccountingControlsClient();
    client.lockExists = false;
    await expect(readModels(client).getPostingLock("source_1")).resolves.toEqual({
      sourceId: "source_1",
      version: 0
    });
  });
});

function readModels(client: PostgresQueryClient) {
  return createFinancialReadModels({
    database: { transaction: async (work) => work(client) },
    tenantId: "tenant_1",
    companyId: "company_1",
    bookId: "book_1"
  });
}

class AccountingControlsClient implements PostgresQueryClient {
  journalListSql = "";
  journalListParams: readonly unknown[] = [];
  fiscalParams: readonly unknown[] = [];
  lockExists = true;

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return result<Row>([{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" }]);
    }
    if (sql.startsWith("with journal as")) {
      this.journalListSql = sql;
      this.journalListParams = params;
      return result<Row>([journalRow("journal_2"), journalRow("journal_1")]);
    }
    if (sql.startsWith('select transaction."transaction_id" as "journal_entry_id"')) {
      return result<Row>([journalRow("journal_2")]);
    }
    if (sql.includes('from "erp_financials"."ledger_postings" posting') && sql.includes('line."transaction_line_id"')) {
      return result<Row>([
        journalLine("line_1", 1, "cash", "source-cash", "Cash", "125.5", "0", "125.5"),
        journalLine("line_2", 2, "revenue", "source-revenue", "Revenue", "0", "125.5", "-125.5")
      ]);
    }
    if (sql.startsWith('select * from "erp_financials"."financial_lifecycle_events"')) {
      return result<Row>([lifecycle("event_post", "journal_entry.posted", "user:preparer", "request-post")]);
    }
    if (sql.includes('from "erp_financials"."journal_entry_links" link') && sql.includes('event."event_type"')) {
      return result<Row>([{
        journal_entry_link_id: "link_correction",
        link_type: "correction",
        original_transaction_id: "journal_2",
        related_transaction_id: "journal_3",
        created_at: "2026-08-16T15:00:00.000Z",
        ...lifecycle("event_correct", "journal_entry.corrected", "user:corrector", "request-correct")
      }]);
    }
    if (sql.startsWith("select period.*")) {
      this.fiscalParams = params;
      return result<Row>([fiscalPeriodRow()]);
    }
    if (sql.startsWith('select source."source_id", controls."posting_lock_date"')) {
      return result<Row>([this.lockExists ? {
        source_id: "source_1",
        posting_lock_date: "2026-08-31",
        version: 4,
        ...lifecycle("event_lock", "accounting_book.posting_lock_changed", "user:closer", "request-lock")
      } : { source_id: "source_1", posting_lock_date: null, version: 0 }]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

function journalRow(id: string): Record<string, unknown> {
  return {
    journal_entry_id: id,
    original_transaction_id: id,
    source_id: "source_1",
    source_transaction_id: `source-${id}`,
    source_transaction_type: "JournalEntry",
    transaction_number: "JE-1002",
    transaction_date: id === "journal_2" ? "2026-08-16" : "2026-08-15",
    posted_at: "2026-08-16T12:00:00.000Z",
    memo: "Accrual correction",
    currency_code: "USD",
    accounting_basis: "accrual",
    total_debit: "125.5",
    total_credit: "125.5",
    line_count: 2,
    source_role: "active",
    source_system: "native_erp",
    provider_environment: "production",
    source_payload_ref: {
      sourceObjectType: "JournalEntry",
      sourceObjectId: "journal-source-2",
      sourceUpdatedAt: "2026-08-16T12:00:00.000Z",
      checksum: "a".repeat(64)
    },
    canonical_status: "corrected",
    version: 3,
    ...prefixed(lifecycle("event_post", "journal_entry.posted", "user:preparer", "request-post"), "preparer")
  };
}

function journalLine(
  id: string,
  number: number,
  accountId: string,
  sourceAccountId: string,
  accountName: string,
  debit: string,
  credit: string,
  net: string
): Record<string, unknown> {
  return {
    transaction_line_id: id,
    posting_id: `posting_${id}`,
    source_posting_id: `source-posting-${id}`,
    line_number: number,
    account_id: accountId,
    source_account_id: sourceAccountId,
    book_account_key: accountId,
    account_number: number === 1 ? "1000" : "4000",
    account_name: accountName,
    classification: number === 1 ? "asset" : "income",
    party_id: null,
    item_id: null,
    description: `${accountName} line`,
    debit_amount: debit,
    credit_amount: credit,
    net_amount: net,
    dimension_refs: []
  };
}

function fiscalPeriodRow(): Record<string, unknown> {
  const close = lifecycle("event_close", "fiscal_period.closed", "user:closer", "request-close", "user:controller");
  return {
    fiscal_period_id: "period_2026_08",
    source_id: "source_1",
    fiscal_year: 2026,
    period_number: 8,
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    status: "closed",
    version: 3,
    created_at: "2026-01-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    close_event_id_read: "event_close",
    close_payload: {
      trialBalanceSnapshotId: "trial_balance_1",
      reconciliationRefs: ["reconciliation_1"],
      checklistRef: "checklist_1",
      postingMaxUpdatedAt: "2026-08-31T23:00:00.000Z",
      evidenceChecksum: "e".repeat(64)
    },
    reopen_event_id_read: null,
    ...prefixed(close, "close"),
    ...prefixed(close, "latest")
  };
}

function lifecycle(
  eventId: string,
  eventType: string,
  actorRef: string,
  requestId: string,
  approverRef?: string
): Record<string, unknown> {
  return {
    event_id: eventId,
    event_type: eventType,
    actor_ref: actorRef,
    approver_ref: approverRef ?? null,
    request_id: requestId,
    correlation_id: "correlation_1",
    reason_code: "accounting_control",
    reason_detail: null,
    occurred_at: "2026-08-16T12:00:00.000Z",
    recorded_at: "2026-08-16T12:00:01.000Z",
    payload_checksum: "b".repeat(64),
    prior_event_id: null
  };
}

function prefixed(value: Record<string, unknown>, prefix: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [`${prefix}_${key}`, entry]));
}

function result<Row extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[]
): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: rows as unknown as readonly Row[], rowCount: rows.length });
}
