import { describe, expect, it } from "vitest";

import {
  FiscalPeriodConcurrencyError,
  PostingDateLockedError,
  assertPostingDateAllowed,
  createFiscalCloseEvidenceChecksum,
  createFiscalPeriodService
} from "../src/index.js";

import type {
  FiscalPeriodTransactionRunner,
  PostgresQueryClient,
  PostgresQueryResult
} from "../src/index.js";

describe("fiscal period and posting lock controls", () => {
  it("defines, enters closing, closes with evidence, locks posting, and reopens with independent approval", async () => {
    const database = new FiscalDatabase();
    const periods = service(database);

    const defined = await periods.define({
      fiscalYear: 2026,
      periodNumber: 8,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      operation: operation("define", false)
    });
    expect(defined).toMatchObject({ outcome: "defined", status: "open", version: 1 });

    const closing = await periods.beginClose({
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: 1,
      operation: operation("begin-close", false)
    });
    const closingRetry = await periods.beginClose({
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: 1,
      operation: operation("begin-close-retry", false)
    });
    expect(closing).toMatchObject({ outcome: "closing", status: "closing", version: 2 });
    expect(closingRetry).toMatchObject({ outcome: "already_closing", status: "closing", version: 2 });

    const closed = await periods.close({
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: 2,
      evidence: closeEvidence(),
      operation: operation("close", true)
    });
    expect(closed).toMatchObject({ outcome: "closed", status: "closed", version: 3 });
    expect(database.client.lockDate).toBe("2026-08-31");
    await expect(
      assertPostingDateAllowed(database.client, scope(), "2026-08-15")
    ).rejects.toBeInstanceOf(PostingDateLockedError);

    const reopened = await periods.reopen({
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: 3,
      operation: operation("reopen", true)
    });
    expect(reopened).toMatchObject({ outcome: "reopened", status: "open", version: 4 });
    expect(database.client.lockDate).toBeUndefined();
    await expect(assertPostingDateAllowed(database.client, scope(), "2026-08-15")).resolves.toBeUndefined();
    expect(database.commits).toBe(5);
    expect(database.rollbacks).toBe(0);
  });

  it("requires independent approval for close, reopen, lock-date, and adjustment-class operations", async () => {
    const database = new FiscalDatabase();
    const periods = service(database);

    await expect(
      periods.close({
        fiscalPeriodId: "period_1",
        expectedVersion: 1,
        evidence: closeEvidence(),
        operation: operation("close-no-approval", false)
      })
    ).rejects.toThrow("operation.approverRef is required");
    await expect(
      periods.setPostingLockDate({
        postingLockDate: "2026-08-31",
        expectedVersion: 0,
        operation: operation("lock-no-approval", false)
      })
    ).rejects.toThrow("operation.approverRef is required");
    expect(database.transactionCalls).toBe(0);
  });

  it("enforces optimistic versions and rolls lifecycle writes back with the failed close", async () => {
    const database = new FiscalDatabase();
    const periods = service(database);
    const defined = await periods.define({
      fiscalYear: 2026,
      periodNumber: 8,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      operation: operation("define-concurrency", false)
    });
    const eventCount = database.client.events.size;

    await expect(
      periods.close({
        fiscalPeriodId: defined.fiscalPeriodId,
        expectedVersion: 9,
        evidence: closeEvidence(),
        operation: operation("close-stale", true)
      })
    ).rejects.toBeInstanceOf(FiscalPeriodConcurrencyError);

    await expect(
      periods.close({
        fiscalPeriodId: defined.fiscalPeriodId,
        expectedVersion: 1,
        evidence: closeEvidence(),
        operation: operation("close-without-preparation", true)
      })
    ).rejects.toThrow("must be closing before it can close");

    expect(database.client.periods[0]?.status).toBe("open");
    expect(database.client.events.size).toBe(eventCount);
    expect(database.rollbacks).toBe(2);
  });

  it("allows approved adjustments while closing but rejects ordinary and closed-period postings", async () => {
    const client = new FiscalClient();
    client.periods.push(periodRow("period_closing", "closing", 1));

    await expect(assertPostingDateAllowed(client, scope(), "2026-08-12")).rejects.toThrow(
      "fiscal period is closing"
    );
    await expect(
      assertPostingDateAllowed(client, scope(), "2026-08-12", { allowClosingAdjustment: true })
    ).resolves.toBeUndefined();

    client.periods[0] = periodRow("period_closed", "closed", 2);
    await expect(
      assertPostingDateAllowed(client, scope(), "2026-08-12", { allowClosingAdjustment: true })
    ).rejects.toThrow("fiscal period is closed");
  });

  it("requires explicit close evidence and blocks close while draft transactions remain", async () => {
    const database = new FiscalDatabase();
    const periods = service(database);
    const defined = await periods.define({
      fiscalYear: 2026,
      periodNumber: 8,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      operation: operation("define-drafts", false)
    });
    const closing = await periods.beginClose({
      fiscalPeriodId: defined.fiscalPeriodId,
      expectedVersion: 1,
      operation: operation("begin-close-drafts", false)
    });
    await expect(
      periods.close({
        fiscalPeriodId: defined.fiscalPeriodId,
        expectedVersion: closing.version,
        evidence: { ...closeEvidence(), evidenceChecksum: "0".repeat(64) },
        operation: operation("close-bad-evidence", true)
      })
    ).rejects.toThrow("does not match the close evidence fields");
    database.client.pendingDrafts = 2;

    await expect(
      periods.close({
        fiscalPeriodId: defined.fiscalPeriodId,
        expectedVersion: closing.version,
        evidence: closeEvidence(),
        operation: operation("close-drafts", true)
      })
    ).rejects.toThrow("draft transactions remain");
    expect(database.client.periods[0]?.status).toBe("closing");
  });
});

class FiscalDatabase implements FiscalPeriodTransactionRunner {
  readonly client = new FiscalClient();
  transactionCalls = 0;
  commits = 0;
  rollbacks = 0;

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

class FiscalClient implements PostgresQueryClient {
  periods: Record<string, unknown>[] = [];
  events = new Map<string, Record<string, unknown>>();
  lockDate: string | undefined;
  bookVersion = 0;
  pendingDrafts = 0;

  snapshot() {
    return {
      periods: structuredClone(this.periods),
      events: structuredClone([...this.events.entries()]),
      lockDate: this.lockDate,
      bookVersion: this.bookVersion,
      pendingDrafts: this.pendingDrafts
    };
  }

  restore(snapshot: ReturnType<FiscalClient["snapshot"]>): void {
    this.periods = snapshot.periods;
    this.events = new Map(snapshot.events);
    this.lockDate = snapshot.lockDate;
    this.bookVersion = snapshot.bookVersion;
    this.pendingDrafts = snapshot.pendingDrafts;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes("pg_advisory_xact_lock")) {
      return this.result<Row>([]);
    }
    if (sql.startsWith('insert into "erp_financials"."financial_lifecycle_events"')) {
      const key = String(params[15]);
      const existing = this.events.get(key);
      if (existing !== undefined) {
        return this.result<Row>([], 0);
      }
      const row = {
        event_id: params[0],
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
      this.events.set(key, row);
      return this.result<Row>([row], 1);
    }
    if (sql.includes('from "erp_financials"."financial_lifecycle_events"')) {
      const event = sql.includes('"aggregate_type" = \'fiscal_period\'')
        ? [...this.events.values()].find((candidate) => candidate.aggregate_id === params[3])
        : this.events.get(String(params[3]));
      return this.result<Row>(event === undefined ? [] : [event]);
    }
    if (sql.startsWith('insert into "erp_financials"."fiscal_periods"')) {
      const existing = this.periods.find((row) => row.fiscal_year === params[4] && row.period_number === params[5]);
      if (existing !== undefined) {
        return this.result<Row>([], 0);
      }
      const row = periodRow(String(params[0]), "open", 1, Number(params[4]), Number(params[5]), String(params[6]), String(params[7]));
      this.periods.push(row);
      return this.result<Row>([row], 1);
    }
    if (sql.includes('from "erp_financials"."fiscal_periods"') && sql.includes('"fiscal_year" = $4')) {
      const row = this.periods.find((candidate) => candidate.fiscal_year === params[3] && candidate.period_number === params[4]);
      return this.result<Row>(row === undefined ? [] : [row]);
    }
    if (sql.includes('from "erp_financials"."fiscal_periods"') && sql.includes("for update")) {
      const row = this.periods.find((candidate) => candidate.fiscal_period_id === params[3]);
      return this.result<Row>(row === undefined ? [] : [row]);
    }
    if (sql.includes("count(*)::integer") && sql.includes('"status" = \'draft\'')) {
      return this.result<Row>([{ pending_count: this.pendingDrafts }]);
    }
    if (sql.startsWith('update "erp_financials"."fiscal_periods"')) {
      const row = this.periods.find((candidate) => candidate.fiscal_period_id === params[3]);
      const expectedVersion = sql.includes("set \"status\" = 'closing'") ? params[5] : params[6];
      if (row === undefined || row.version !== expectedVersion) {
        return this.result<Row>([], 0);
      }
      if (sql.includes("set \"status\" = 'closed'")) {
        row.status = "closed";
        row.close_event_id = params[4];
      } else if (sql.includes("set \"status\" = 'closing'")) {
        row.status = "closing";
      } else {
        row.status = "open";
        row.reopen_event_id = params[4];
      }
      row.version = Number(row.version) + 1;
      return this.result<Row>([row], 1);
    }
    if (sql.includes('from "erp_financials"."accounting_book_controls"')) {
      return this.result<Row>(this.bookVersion === 0 ? [] : [{ posting_lock_date: this.lockDate ?? null }]);
    }
    if (sql.startsWith('insert into "erp_financials"."accounting_book_controls"')) {
      const isExplicitLockChange = sql.includes("where $8 = 0");
      if (isExplicitLockChange) {
        const expected = Number(params[7]);
        if ((this.bookVersion === 0 && expected !== 0) || (this.bookVersion > 0 && expected !== this.bookVersion)) {
          return this.result<Row>([], 0);
        }
        this.bookVersion += 1;
        this.lockDate = typeof params[4] === "string" ? params[4] : undefined;
        return this.result<Row>([{ posting_lock_date: this.lockDate ?? null, version: this.bookVersion }], 1);
      }
      this.bookVersion += 1;
      const next = String(params[4]);
      if (this.lockDate === undefined || next > this.lockDate) {
        this.lockDate = next;
      }
      return this.result<Row>([]);
    }
    if (sql.startsWith('update "erp_financials"."accounting_book_controls" controls')) {
      this.bookVersion += 1;
      const remainingClosed = this.periods
        .filter((row) => row.status === "closed")
        .map((row) => String(row.period_end))
        .sort();
      this.lockDate = remainingClosed.at(-1);
      return this.result<Row>([]);
    }
    if (sql.includes('from "erp_financials"."fiscal_periods"') && sql.includes("between \"period_start\"")) {
      const date = String(params[3]);
      const row = this.periods.find((candidate) => String(candidate.period_start) <= date && date <= String(candidate.period_end));
      return this.result<Row>(row === undefined ? [] : [{ fiscal_period_id: row.fiscal_period_id, status: row.status }]);
    }
    throw new Error(`Unexpected fiscal test SQL: ${sql.slice(0, 120)}`);
  }

  private result<Row extends Record<string, unknown>>(
    rows: readonly Record<string, unknown>[],
    rowCount: number | null = rows.length
  ): Promise<PostgresQueryResult<Row>> {
    return Promise.resolve({ rows: rows as readonly Row[], rowCount });
  }
}

function service(database: FiscalPeriodTransactionRunner) {
  return createFiscalPeriodService({ ...scope(), database, now: () => "2026-08-12T15:00:01.000Z" });
}

function scope() {
  return { tenantId: "tenant_1", companyId: "company_1", sourceId: "source_1" } as const;
}

function operation(request: string, approved: boolean) {
  return {
    actorRef: "user:controller",
    ...(approved ? { approverRef: "user:cfo" } : {}),
    requestId: `request:${request}`,
    correlationId: "correlation:august-close",
    reasonCode: request,
    occurredAt: "2026-08-12T15:00:00.000Z"
  } as const;
}

function closeEvidence() {
  const evidence = {
    trialBalanceSnapshotId: "snapshot:trial-balance:2026-08",
    reconciliationRefs: ["reconciliation:bank:2026-08", "reconciliation:ar:2026-08"],
    checklistRef: "close-checklist:2026-08",
    postingMaxUpdatedAt: "2026-08-31T23:59:59.000Z"
  } as const;
  return { ...evidence, evidenceChecksum: createFiscalCloseEvidenceChecksum(evidence) };
}

function periodRow(
  fiscalPeriodId: string,
  status: "open" | "closing" | "closed",
  version: number,
  fiscalYear = 2026,
  periodNumber = 8,
  periodStart = "2026-08-01",
  periodEnd = "2026-08-31"
): Record<string, unknown> {
  return {
    fiscal_period_id: fiscalPeriodId,
    fiscal_year: fiscalYear,
    period_number: periodNumber,
    period_start: periodStart,
    period_end: periodEnd,
    status,
    version,
    close_event_id: status === "closed" ? "event_close" : null
  };
}
