import { assertFinancialApproval, runFinancialAction, type FinancialApprovalPolicy } from "./financial-approval-policy.js";
import { createHash } from "node:crypto";

import {
  appendFinancialLifecycleEvent,
  assertFinancialOperationContext,
} from "./financial-lifecycle.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { IsoDate, IsoDateTime, JsonValue } from "./canonical-model.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

export type FiscalPeriodStatus = "open" | "closing" | "closed";

export type FiscalPeriodScope = {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
};

export type FiscalPeriodTransactionRunner = {
  transaction<Result>(operation: (client: PostgresQueryClient) => Promise<Result>): Promise<Result>;
};

export type FiscalPeriodServiceContext = FiscalPeriodScope & {
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: FiscalPeriodTransactionRunner;
  readonly now: () => IsoDateTime;
};

export type DefineFiscalPeriodInput = {
  readonly fiscalYear: number;
  readonly periodNumber: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly operation: FinancialOperationContext;
};

export type FiscalCloseEvidence = {
  readonly trialBalanceSnapshotId: string;
  readonly reconciliationRefs: readonly string[];
  readonly checklistRef: string;
  readonly postingMaxUpdatedAt: IsoDateTime;
  readonly evidenceChecksum: string;
};

export type FiscalCloseEvidenceMaterial = Omit<FiscalCloseEvidence, "evidenceChecksum">;

export type CloseFiscalPeriodInput = {
  readonly fiscalPeriodId: string;
  readonly expectedVersion: number;
  readonly evidence: FiscalCloseEvidence;
  readonly operation: FinancialOperationContext;
};

export type BeginFiscalPeriodCloseInput = {
  readonly fiscalPeriodId: string;
  readonly expectedVersion: number;
  readonly operation: FinancialOperationContext;
};

export type ReopenFiscalPeriodInput = {
  readonly fiscalPeriodId: string;
  readonly expectedVersion: number;
  readonly operation: FinancialOperationContext;
};

export type SetPostingLockDateInput = {
  readonly postingLockDate?: IsoDate;
  readonly expectedVersion: number;
  readonly operation: FinancialOperationContext;
};

export type FiscalPeriodResult = {
  readonly fiscalPeriodId: string;
  readonly fiscalYear: number;
  readonly periodNumber: number;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly status: FiscalPeriodStatus;
  readonly version: number;
  readonly lifecycleEventId: string;
  readonly outcome:
    | "defined"
    | "already_defined"
    | "closing"
    | "already_closing"
    | "closed"
    | "already_closed"
    | "reopened";
};

export type PostingLockDateResult = {
  readonly postingLockDate?: IsoDate;
  readonly version: number;
  readonly lifecycleEventId: string;
};

export type FiscalPeriodService = {
  define(input: DefineFiscalPeriodInput): Promise<FiscalPeriodResult>;
  beginClose(input: BeginFiscalPeriodCloseInput): Promise<FiscalPeriodResult>;
  close(input: CloseFiscalPeriodInput): Promise<FiscalPeriodResult>;
  reopen(input: ReopenFiscalPeriodInput): Promise<FiscalPeriodResult>;
  setPostingLockDate(input: SetPostingLockDateInput): Promise<PostingLockDateResult>;
};

type FiscalPeriodRow = Record<string, unknown> & {
  readonly fiscal_period_id?: unknown;
  readonly fiscal_year?: unknown;
  readonly period_number?: unknown;
  readonly period_start?: unknown;
  readonly period_end?: unknown;
  readonly status?: unknown;
  readonly version?: unknown;
  readonly close_event_id?: unknown;
};

export class FiscalPeriodValidationError extends ErpFinancialsError {
  constructor(message: string) {
    super("invalid_input", message);
    this.name = "FiscalPeriodValidationError";
    Object.setPrototypeOf(this, FiscalPeriodValidationError.prototype);
  }
}

export class FiscalPeriodConcurrencyError extends ErpFinancialsError {
  constructor(message: string) {
    super("optimistic_concurrency_conflict", message, { retryable: true });
    this.name = "FiscalPeriodConcurrencyError";
    Object.setPrototypeOf(this, FiscalPeriodConcurrencyError.prototype);
  }
}

export class PostingDateLockedError extends ErpFinancialsError {
  readonly postingDate: IsoDate;

  constructor(postingDate: IsoDate, reason: string) {
    super(reason.includes("closing") ? "fiscal_period_closing" : "fiscal_period_closed", `Posting date ${postingDate} is locked: ${reason}`, {
      details: { postingDate, reason }
    });
    this.name = "PostingDateLockedError";
    this.postingDate = postingDate;
    Object.setPrototypeOf(this, PostingDateLockedError.prototype);
  }
}

export function createFiscalPeriodService(context: FiscalPeriodServiceContext): FiscalPeriodService {
  assertScope(context);
  return {
    define(input) {
      return defineFiscalPeriod(context, input);
    },
    beginClose(input) {
      return beginFiscalPeriodClose(context, input);
    },
    close(input) {
      return runFinancialAction(context, "fiscalPeriods.close", input, closeFiscalPeriod);
    },
    reopen(input) {
      return runFinancialAction(context, "fiscalPeriods.reopen", input, reopenFiscalPeriod);
    },
    setPostingLockDate(input) {
      return runFinancialAction(context, "fiscalPeriods.setPostingLockDate", input, setPostingLockDate);
    }
  };
}

export function createFiscalCloseEvidenceChecksum(evidence: FiscalCloseEvidenceMaterial): string {
  assertCloseEvidenceMaterial(evidence);
  return createHash("sha256")
    .update(
      JSON.stringify({
        checklistRef: evidence.checklistRef,
        postingMaxUpdatedAt: new Date(evidence.postingMaxUpdatedAt).toISOString(),
        reconciliationRefs: evidence.reconciliationRefs,
        trialBalanceSnapshotId: evidence.trialBalanceSnapshotId
      })
    )
    .digest("hex");
}

async function beginFiscalPeriodClose(
  context: FiscalPeriodServiceContext,
  input: BeginFiscalPeriodCloseInput
): Promise<FiscalPeriodResult> {
  assertFinancialOperationContext(input.operation);
  assertExpectedVersion(input.expectedVersion);

  return context.database.transaction(async (client) => {
    await lockFiscalScope(client, context);
    const period = await loadPeriodForUpdate(client, context, input.fiscalPeriodId);
    const version = requiredInteger(period.version, "version");
    const status = requiredStatus(period.status);
    if (status === "closing") {
      return periodResult(period, await latestPeriodEventId(client, context, input.fiscalPeriodId), "already_closing");
    }
    if (status !== "open") {
      throw new FiscalPeriodValidationError(
        `Fiscal period ${input.fiscalPeriodId} must be open before close preparation can begin`
      );
    }
    if (version !== input.expectedVersion) {
      throw new FiscalPeriodConcurrencyError(
        `Fiscal period ${input.fiscalPeriodId} expected version ${String(input.expectedVersion)}, found ${String(version)}`
      );
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      ...scopeOf(context),
      aggregateType: "fiscal_period",
      aggregateId: input.fiscalPeriodId,
      eventType: "fiscal_period.closing_started",
      idempotencyKey: `fiscal-period:${input.fiscalPeriodId}:begin-close:v${String(version)}`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: { priorStatus: "open", priorVersion: version }
    });
    const updated = await client.query<FiscalPeriodRow>(
      `update "erp_financials"."fiscal_periods"
set "status" = 'closing', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "fiscal_period_id" = $4 and "version" = $6
returning *`,
      [context.tenantId, context.companyId, context.sourceId, input.fiscalPeriodId, context.now(), version]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new FiscalPeriodConcurrencyError(
        `Fiscal period ${input.fiscalPeriodId} changed while close preparation was beginning`
      );
    }
    return periodResult(row, lifecycle.eventId, "closing");
  });
}

export async function assertPostingDateAllowed(
  client: PostgresQueryClient,
  scope: FiscalPeriodScope,
  postingDate: IsoDate,
  options: { readonly allowClosingAdjustment?: boolean } = {}
): Promise<void> {
  assertScope(scope);
  assertIsoDate(postingDate, "postingDate");
  const lock = await client.query(
    `select "posting_lock_date"
from "erp_financials"."accounting_book_controls"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
for key share`,
    [scope.tenantId, scope.companyId, scope.sourceId]
  );
  const lockDate = optionalDate(lock.rows[0]?.posting_lock_date);
  if (lockDate !== undefined && postingDate <= lockDate) {
    throw new PostingDateLockedError(postingDate, `book lock date is ${lockDate}`);
  }

  const periods = await client.query<FiscalPeriodRow>(
    `select "fiscal_period_id", "status"
from "erp_financials"."fiscal_periods"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and $4::date between "period_start" and "period_end"
for key share`,
    [scope.tenantId, scope.companyId, scope.sourceId, postingDate]
  );
  const period = periods.rows[0];
  if (period === undefined) {
    throw new PostingDateLockedError(postingDate, "no fiscal period is defined");
  }
  const status = requiredStatus(period.status);
  if (status !== "open" && !(status === "closing" && options.allowClosingAdjustment === true)) {
    throw new PostingDateLockedError(postingDate, `fiscal period is ${status}`);
  }
}

async function defineFiscalPeriod(
  context: FiscalPeriodServiceContext,
  input: DefineFiscalPeriodInput
): Promise<FiscalPeriodResult> {
  assertFinancialOperationContext(input.operation);
  assertPositiveInteger(input.fiscalYear, "fiscalYear");
  if (!Number.isInteger(input.periodNumber) || input.periodNumber < 1 || input.periodNumber > 366) {
    throw new FiscalPeriodValidationError("periodNumber must be an integer between 1 and 366");
  }
  assertIsoDate(input.periodStart, "periodStart");
  assertIsoDate(input.periodEnd, "periodEnd");
  if (input.periodStart > input.periodEnd) {
    throw new FiscalPeriodValidationError("periodStart must be on or before periodEnd");
  }
  const fiscalPeriodId = periodId(context, input.fiscalYear, input.periodNumber);

  return context.database.transaction(async (client) => {
    await lockFiscalScope(client, context);
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      ...scopeOf(context),
      aggregateType: "fiscal_period",
      aggregateId: fiscalPeriodId,
      eventType: "fiscal_period.defined",
      idempotencyKey: `fiscal-period:${fiscalPeriodId}:defined`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: {
        fiscalYear: input.fiscalYear,
        periodEnd: input.periodEnd,
        periodNumber: input.periodNumber,
        periodStart: input.periodStart
      }
    });
    const inserted = await client.query<FiscalPeriodRow>(
      `insert into "erp_financials"."fiscal_periods" (
  "fiscal_period_id", "tenant_id", "company_id", "source_id", "fiscal_year", "period_number",
  "period_start", "period_end", "status", "version", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', 1, $9, $9)
on conflict ("tenant_id", "company_id", "source_id", "fiscal_year", "period_number") do nothing
returning *`,
      [
        fiscalPeriodId,
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.fiscalYear,
        input.periodNumber,
        input.periodStart,
        input.periodEnd,
        context.now()
      ]
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return periodResult(insertedRow, lifecycle.eventId, "defined");
    }
    const existing = await loadPeriodByIdentity(client, context, input.fiscalYear, input.periodNumber);
    if (
      existing === undefined ||
      requiredString(existing.fiscal_period_id, "fiscal_period_id") !== fiscalPeriodId ||
      requiredDate(existing.period_start, "period_start") !== input.periodStart ||
      requiredDate(existing.period_end, "period_end") !== input.periodEnd
    ) {
      throw new FiscalPeriodValidationError("Fiscal period identity is already defined with different dates");
    }
    return periodResult(existing, lifecycle.eventId, "already_defined");
  });
}

async function closeFiscalPeriod(
  context: FiscalPeriodServiceContext,
  input: CloseFiscalPeriodInput
): Promise<FiscalPeriodResult> {
  assertFinancialApproval(context, input.operation);
  assertExpectedVersion(input.expectedVersion);
  assertCloseEvidence(input.evidence);

  return context.database.transaction(async (client) => {
    await lockFiscalScope(client, context);
    const period = await loadPeriodForUpdate(client, context, input.fiscalPeriodId);
    const version = requiredInteger(period.version, "version");
    const status = requiredStatus(period.status);
    if (status === "closed") {
      const closeEventId = requiredString(period.close_event_id, "close_event_id");
      return periodResult(period, closeEventId, "already_closed");
    }
    if (version !== input.expectedVersion) {
      throw new FiscalPeriodConcurrencyError(
        `Fiscal period ${input.fiscalPeriodId} expected version ${String(input.expectedVersion)}, found ${String(version)}`
      );
    }
    if (status !== "closing") {
      throw new FiscalPeriodValidationError(
        `Fiscal period ${input.fiscalPeriodId} must be closing before it can close`
      );
    }
    const pending = await client.query(
      `select count(*)::integer as "pending_count"
from "erp_financials"."transactions"
where "tenant_id" = $1 and "source_id" = $2 and "status" = 'draft'
  and "transaction_date" between $3::date and $4::date`,
      [context.tenantId, context.sourceId, requiredDate(period.period_start, "period_start"), requiredDate(period.period_end, "period_end")]
    );
    if (requiredInteger(pending.rows[0]?.pending_count ?? 0, "pending_count") > 0) {
      throw new FiscalPeriodValidationError("Fiscal period cannot close while draft transactions remain");
    }
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      ...scopeOf(context),
      aggregateType: "fiscal_period",
      aggregateId: input.fiscalPeriodId,
      eventType: "fiscal_period.closed",
      idempotencyKey: `fiscal-period:${input.fiscalPeriodId}:close:v${String(version)}`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: closeEvidencePayload(input.evidence, version)
    });
    const updated = await client.query<FiscalPeriodRow>(
      `update "erp_financials"."fiscal_periods"
set "status" = 'closed', "version" = "version" + 1, "close_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "fiscal_period_id" = $4 and "version" = $7
returning *`,
      [
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.fiscalPeriodId,
        lifecycle.eventId,
        context.now(),
        version
      ]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new FiscalPeriodConcurrencyError(`Fiscal period ${input.fiscalPeriodId} changed while it was closing`);
    }
    await advanceBookLock(client, context, requiredDate(period.period_end, "period_end"), lifecycle.eventId);
    return periodResult(row, lifecycle.eventId, "closed");
  });
}

async function reopenFiscalPeriod(
  context: FiscalPeriodServiceContext,
  input: ReopenFiscalPeriodInput
): Promise<FiscalPeriodResult> {
  assertFinancialApproval(context, input.operation);
  assertExpectedVersion(input.expectedVersion);
  return context.database.transaction(async (client) => {
    await lockFiscalScope(client, context);
    const period = await loadPeriodForUpdate(client, context, input.fiscalPeriodId);
    const version = requiredInteger(period.version, "version");
    if (version !== input.expectedVersion) {
      throw new FiscalPeriodConcurrencyError(
        `Fiscal period ${input.fiscalPeriodId} expected version ${String(input.expectedVersion)}, found ${String(version)}`
      );
    }
    if (requiredStatus(period.status) !== "closed") {
      throw new FiscalPeriodValidationError(`Fiscal period ${input.fiscalPeriodId} must be closed before it can reopen`);
    }
    const closeEventId = requiredString(period.close_event_id, "close_event_id");
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      ...scopeOf(context),
      aggregateType: "fiscal_period",
      aggregateId: input.fiscalPeriodId,
      eventType: "fiscal_period.reopened",
      idempotencyKey: `fiscal-period:${input.fiscalPeriodId}:reopen:v${String(version)}`,
      operation: input.operation,
      recordedAt: context.now(),
      priorEventId: closeEventId,
      payload: { priorCloseEventId: closeEventId, priorVersion: version }
    });
    const updated = await client.query<FiscalPeriodRow>(
      `update "erp_financials"."fiscal_periods"
set "status" = 'open', "version" = "version" + 1, "reopen_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "fiscal_period_id" = $4 and "version" = $7
returning *`,
      [
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.fiscalPeriodId,
        lifecycle.eventId,
        context.now(),
        version
      ]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new FiscalPeriodConcurrencyError(`Fiscal period ${input.fiscalPeriodId} changed while it was reopening`);
    }
    await recomputeBookLock(client, context, lifecycle.eventId);
    return periodResult(row, lifecycle.eventId, "reopened");
  });
}

async function setPostingLockDate(
  context: FiscalPeriodServiceContext,
  input: SetPostingLockDateInput
): Promise<PostingLockDateResult> {
  assertFinancialApproval(context, input.operation);
  if (input.postingLockDate !== undefined) {
    assertIsoDate(input.postingLockDate, "postingLockDate");
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new FiscalPeriodValidationError("expectedVersion must be a nonnegative integer");
  }
  return context.database.transaction(async (client) => {
    await lockFiscalScope(client, context);
    const lifecycle = await appendFinancialLifecycleEvent(client, {
      ...scopeOf(context),
      aggregateType: "accounting_book",
      aggregateId: bookControlId(context),
      eventType: "accounting_book.posting_lock_changed",
      idempotencyKey: `accounting-book:${bookControlId(context)}:lock:${input.operation.requestId}`,
      operation: input.operation,
      recordedAt: context.now(),
      payload: { postingLockDate: input.postingLockDate ?? null, priorVersion: input.expectedVersion }
    });
    const result = await client.query(
      `insert into "erp_financials"."accounting_book_controls" (
  "book_control_id", "tenant_id", "company_id", "source_id", "posting_lock_date", "version", "last_event_id", "created_at", "updated_at"
) select $1, $2, $3, $4, $5, 1, $6, $7, $7 where $8 = 0
on conflict ("tenant_id", "company_id", "source_id") do update
set "posting_lock_date" = excluded."posting_lock_date",
    "version" = "accounting_book_controls"."version" + 1,
    "last_event_id" = excluded."last_event_id",
    "updated_at" = excluded."updated_at"
where "accounting_book_controls"."version" = $8
returning "posting_lock_date", "version"`,
      [
        bookControlId(context),
        context.tenantId,
        context.companyId,
        context.sourceId,
        input.postingLockDate,
        lifecycle.eventId,
        context.now(),
        input.expectedVersion
      ]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new FiscalPeriodConcurrencyError("Accounting book lock date changed concurrently");
    }
    const postingLockDate = optionalDate(row.posting_lock_date);
    return {
      ...(postingLockDate === undefined ? {} : { postingLockDate }),
      version: requiredInteger(row.version, "version"),
      lifecycleEventId: lifecycle.eventId
    };
  });
}

async function advanceBookLock(
  client: PostgresQueryClient,
  context: FiscalPeriodServiceContext,
  periodEnd: IsoDate,
  eventId: string
): Promise<void> {
  await client.query(
    `insert into "erp_financials"."accounting_book_controls" (
  "book_control_id", "tenant_id", "company_id", "source_id", "posting_lock_date", "version", "last_event_id", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, 1, $6, $7, $7)
on conflict ("tenant_id", "company_id", "source_id") do update
set "posting_lock_date" = greatest("accounting_book_controls"."posting_lock_date", excluded."posting_lock_date"),
    "version" = "accounting_book_controls"."version" + 1,
    "last_event_id" = excluded."last_event_id",
    "updated_at" = excluded."updated_at"`,
    [bookControlId(context), context.tenantId, context.companyId, context.sourceId, periodEnd, eventId, context.now()]
  );
}

async function recomputeBookLock(
  client: PostgresQueryClient,
  context: FiscalPeriodServiceContext,
  eventId: string
): Promise<void> {
  await client.query(
    `update "erp_financials"."accounting_book_controls" controls
set "posting_lock_date" = closed."lock_date", "version" = controls."version" + 1,
    "last_event_id" = $4, "updated_at" = $5
from (
  select max("period_end") as "lock_date"
  from "erp_financials"."fiscal_periods"
  where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "status" = 'closed'
) closed
where controls."tenant_id" = $1 and controls."company_id" = $2 and controls."source_id" = $3`,
    [context.tenantId, context.companyId, context.sourceId, eventId, context.now()]
  );
}

async function loadPeriodForUpdate(
  client: PostgresQueryClient,
  context: FiscalPeriodScope,
  fiscalPeriodId: string
): Promise<FiscalPeriodRow> {
  assertNonEmpty(fiscalPeriodId, "fiscalPeriodId");
  const result = await client.query<FiscalPeriodRow>(
    `select * from "erp_financials"."fiscal_periods"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "fiscal_period_id" = $4
for update`,
    [context.tenantId, context.companyId, context.sourceId, fiscalPeriodId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FiscalPeriodValidationError(`Fiscal period ${fiscalPeriodId} does not exist in this scope`);
  }
  return row;
}

async function loadPeriodByIdentity(
  client: PostgresQueryClient,
  context: FiscalPeriodScope,
  fiscalYear: number,
  periodNumber: number
): Promise<FiscalPeriodRow | undefined> {
  const result = await client.query<FiscalPeriodRow>(
    `select * from "erp_financials"."fiscal_periods"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "fiscal_year" = $4 and "period_number" = $5
for key share`,
    [context.tenantId, context.companyId, context.sourceId, fiscalYear, periodNumber]
  );
  return result.rows[0];
}

async function latestPeriodEventId(
  client: PostgresQueryClient,
  context: FiscalPeriodScope,
  fiscalPeriodId: string
): Promise<string> {
  const result = await client.query(
    `select "event_id"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3
  and "aggregate_type" = 'fiscal_period' and "aggregate_id" = $4
order by "occurred_at" desc, "recorded_at" desc, "event_id" desc
limit 1`,
    [context.tenantId, context.companyId, context.sourceId, fiscalPeriodId]
  );
  return requiredString(result.rows[0]?.event_id, "event_id");
}

async function lockFiscalScope(client: PostgresQueryClient, context: FiscalPeriodScope): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `fiscal-period:${context.tenantId}:${context.companyId}:${context.sourceId}`
  ]);
}

function periodResult(
  row: FiscalPeriodRow,
  lifecycleEventId: string,
  outcome: FiscalPeriodResult["outcome"]
): FiscalPeriodResult {
  return {
    fiscalPeriodId: requiredString(row.fiscal_period_id, "fiscal_period_id"),
    fiscalYear: requiredInteger(row.fiscal_year, "fiscal_year"),
    periodNumber: requiredInteger(row.period_number, "period_number"),
    periodStart: requiredDate(row.period_start, "period_start"),
    periodEnd: requiredDate(row.period_end, "period_end"),
    status: requiredStatus(row.status),
    version: requiredInteger(row.version, "version"),
    lifecycleEventId,
    outcome
  };
}

function closeEvidencePayload(evidence: FiscalCloseEvidence, priorVersion: number): JsonValue {
  return {
    checklistRef: evidence.checklistRef,
    evidenceChecksum: evidence.evidenceChecksum,
    postingMaxUpdatedAt: evidence.postingMaxUpdatedAt,
    priorVersion,
    reconciliationRefs: evidence.reconciliationRefs,
    trialBalanceSnapshotId: evidence.trialBalanceSnapshotId
  };
}

function assertCloseEvidence(evidence: FiscalCloseEvidence): void {
  assertCloseEvidenceMaterial(evidence);
  if (!/^[a-f0-9]{64}$/u.test(evidence.evidenceChecksum)) {
    throw new FiscalPeriodValidationError("evidence.evidenceChecksum must be a lowercase SHA-256 digest");
  }
  if (evidence.evidenceChecksum !== createFiscalCloseEvidenceChecksum(evidence)) {
    throw new FiscalPeriodValidationError("evidence.evidenceChecksum does not match the close evidence fields");
  }
}

function assertCloseEvidenceMaterial(evidence: FiscalCloseEvidenceMaterial): void {
  assertNonEmpty(evidence.trialBalanceSnapshotId, "evidence.trialBalanceSnapshotId");
  assertNonEmpty(evidence.checklistRef, "evidence.checklistRef");
  assertIsoDateTime(evidence.postingMaxUpdatedAt, "evidence.postingMaxUpdatedAt");
  if (evidence.reconciliationRefs.length === 0 || evidence.reconciliationRefs.some((ref) => ref.trim().length === 0)) {
    throw new FiscalPeriodValidationError("evidence.reconciliationRefs must include at least one non-empty reference");
  }
}

function periodId(scope: FiscalPeriodScope, fiscalYear: number, periodNumber: number): string {
  const digest = createHash("sha256")
    .update([scope.tenantId, scope.companyId, scope.sourceId, fiscalYear, periodNumber].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  return `fiscal_period_${digest}`;
}

function bookControlId(scope: FiscalPeriodScope): string {
  const digest = createHash("sha256")
    .update([scope.tenantId, scope.companyId, scope.sourceId].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  return `book_control_${digest}`;
}

function scopeOf(scope: FiscalPeriodScope): FiscalPeriodScope {
  return { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId };
}

function assertScope(scope: FiscalPeriodScope): void {
  assertNonEmpty(scope.tenantId, "tenantId");
  assertNonEmpty(scope.companyId, "companyId");
  assertNonEmpty(scope.sourceId, "sourceId");
}

function assertExpectedVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new FiscalPeriodValidationError("expectedVersion must be a positive integer");
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new FiscalPeriodValidationError(`${field} must be a positive integer`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new FiscalPeriodValidationError(`${field} must not be empty`);
  }
}

function assertIsoDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new FiscalPeriodValidationError(`${field} must be a valid ISO date`);
  }
}

function assertIsoDateTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new FiscalPeriodValidationError(`${field} must be a valid ISO date-time`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Fiscal period row ${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`Fiscal period row ${field} must be an integer`);
  }
  return parsed;
}

function requiredDate(value: unknown, field: string): IsoDate {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : requiredString(value, field);
  assertIsoDate(date, field);
  return date;
}

function optionalDate(value: unknown): IsoDate | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredDate(value, "posting_lock_date");
}

function requiredStatus(value: unknown): FiscalPeriodStatus {
  if (value !== "open" && value !== "closing" && value !== "closed") {
    throw new Error("Fiscal period row status is invalid");
  }
  return value;
}
