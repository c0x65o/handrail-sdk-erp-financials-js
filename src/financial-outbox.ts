import { createHash } from "node:crypto";

import { assertNoCredentialKeys } from "./canonical-model.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { IsoDateTime, JsonValue } from "./canonical-model.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

export const FINANCIAL_OUTBOX_MAX_PAYLOAD_BYTES = 4096;

export type FinancialOutboxStatus = "pending" | "processing" | "published" | "failed";

export type FinancialOutboxEvent = {
  readonly outboxEventId: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId?: string;
  readonly sourceId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly status: FinancialOutboxStatus;
  readonly attemptCount: number;
  readonly availableAt: IsoDateTime;
  readonly leaseExpiresAt?: IsoDateTime;
  readonly lastError?: string;
  readonly createdAt: IsoDateTime;
  readonly publishedAt?: IsoDateTime;
};

export type FinancialOutboxService = {
  claim(input?: { readonly limit?: number; readonly leaseSeconds?: number }): Promise<readonly FinancialOutboxEvent[]>;
  markPublished(outboxEventId: string): Promise<void>;
  markFailed(input: {
    readonly outboxEventId: string;
    readonly error: string;
    readonly retryAt?: IsoDateTime;
    readonly terminal?: boolean;
  }): Promise<void>;
};

export function createFinancialOutboxService(input: {
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId?: string;
  /** Optional independent source consumer. Omission preserves company/book delivery. */
  readonly sourceId?: string;
  readonly now?: () => IsoDateTime;
}): FinancialOutboxService {
  if (input.sourceId !== undefined && (typeof input.sourceId !== "string" || !input.sourceId.trim())) {
    throw new ErpFinancialsError("invalid_input", "Outbox sourceId must be nonempty when provided");
  }
  const now = input.now ?? (() => new Date().toISOString());
  return {
    claim: (request = {}) => claimEvents(input.database, input, now, request),
    markPublished: (outboxEventId) => markPublished(input.database, input, now, outboxEventId),
    markFailed: (request) => markFailed(input.database, input, now, request)
  };
}

export async function appendFinancialOutboxEvent(
  client: PostgresQueryClient,
  input: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly bookId?: string;
    readonly sourceId: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly idempotencyKey: string;
    readonly payload: JsonValue;
    readonly availableAt: IsoDateTime;
  }
): Promise<string> {
  assertNoCredentialKeys(input.payload);
  const serialized = JSON.stringify(input.payload);
  if (Buffer.byteLength(serialized, "utf8") > FINANCIAL_OUTBOX_MAX_PAYLOAD_BYTES) {
    throw new ErpFinancialsError("invalid_input", "Financial outbox payload exceeds 4096 bytes");
  }
  const outboxEventId = stableId("outbox", input.tenantId, input.companyId, input.sourceId, input.idempotencyKey);
  const result = await client.query(
    `insert into "erp_financials"."financial_outbox" (
  "outbox_event_id", "tenant_id", "company_id", "book_id", "source_id", "event_type", "aggregate_type",
  "aggregate_id", "idempotency_key", "payload", "status", "attempt_count", "available_at", "lease_expires_at",
  "last_error", "created_at", "published_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 0, $11, null, null, $11, null)
on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do nothing
returning "outbox_event_id"`,
    [
      outboxEventId,
      input.tenantId,
      input.companyId,
      input.bookId,
      input.sourceId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.idempotencyKey,
      serialized,
      input.availableAt
    ]
  );
  const returnedId = result.rows[0]?.outbox_event_id;
  if (returnedId !== undefined && returnedId !== outboxEventId) {
    throw new Error("Financial outbox returned an unexpected event id");
  }
  if (returnedId === undefined) {
    const existing = await client.query(
      `select "outbox_event_id", "book_id", "event_type", "aggregate_type", "aggregate_id", "payload"
from "erp_financials"."financial_outbox"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
      [input.tenantId, input.companyId, input.sourceId, input.idempotencyKey]
    );
    const row = existing.rows[0];
    const storedPayload = row === undefined
      ? undefined
      : typeof row.payload === "string"
        ? JSON.parse(row.payload) as JsonValue
        : row.payload as JsonValue;
    if (
      row === undefined ||
      row.outbox_event_id !== outboxEventId ||
      normalizeOptional(row.book_id) !== normalizeOptional(input.bookId) ||
      row.event_type !== input.eventType ||
      row.aggregate_type !== input.aggregateType ||
      row.aggregate_id !== input.aggregateId ||
      stableJson(storedPayload) !== stableJson(input.payload)
    ) {
      throw new ErpFinancialsError(
        "idempotency_conflict",
        `Financial outbox key ${input.idempotencyKey} is associated with different content`,
        { details: { idempotencyKey: input.idempotencyKey } }
      );
    }
  }
  return outboxEventId;
}

async function claimEvents(
  database: ErpFinancialsTransactionRunner,
  scope: { readonly tenantId: string; readonly companyId: string; readonly bookId?: string; readonly sourceId?: string },
  now: () => IsoDateTime,
  input: { readonly limit?: number; readonly leaseSeconds?: number }
): Promise<readonly FinancialOutboxEvent[]> {
  const limit = input.limit ?? 50;
  const leaseSeconds = input.leaseSeconds ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ErpFinancialsError("invalid_input", "Outbox claim limit must be between 1 and 500");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
    throw new ErpFinancialsError("invalid_input", "Outbox leaseSeconds must be between 5 and 3600");
  }
  return database.transaction(async (client) => {
    const result = await client.query(
      `with claimable as (
  select "outbox_event_id"
  from "erp_financials"."financial_outbox"
  where "tenant_id" = $1 and "company_id" = $2
    and ($3::text is null or "book_id" = $3)
    and ($7::text is null or "source_id" = $7)
    and "available_at" <= $4::timestamptz
    and ("status" in ('pending', 'failed') or ("status" = 'processing' and "lease_expires_at" <= $4::timestamptz))
  order by "created_at", "outbox_event_id"
  for update skip locked
  limit $5
)
update "erp_financials"."financial_outbox" outbox
set "status" = 'processing', "attempt_count" = "attempt_count" + 1,
    "lease_expires_at" = $4::timestamptz + ($6::text || ' seconds')::interval, "last_error" = null
from claimable
where outbox."outbox_event_id" = claimable."outbox_event_id"
returning outbox.*`,
      [scope.tenantId, scope.companyId, scope.bookId, now(), limit, leaseSeconds, scope.sourceId]
    );
    return result.rows.map(outboxEventFromRow);
  });
}

async function markPublished(
  database: ErpFinancialsTransactionRunner,
  scope: { readonly tenantId: string; readonly companyId: string; readonly bookId?: string; readonly sourceId?: string },
  now: () => IsoDateTime,
  outboxEventId: string
): Promise<void> {
  await database.transaction(async (client) => {
    const result = await client.query(
      `update "erp_financials"."financial_outbox"
set "status" = 'published', "published_at" = $5, "lease_expires_at" = null, "last_error" = null
where "tenant_id" = $1 and "company_id" = $2 and ($3::text is null or "book_id" = $3)
  and "outbox_event_id" = $4 and "status" = 'processing'
  and ($6::text is null or "source_id" = $6)`,
      [scope.tenantId, scope.companyId, scope.bookId, outboxEventId, now(), scope.sourceId]
    );
    if (result.rowCount !== 1) {
      throw new ErpFinancialsError("terminal_state_conflict", `Outbox event ${outboxEventId} is not processing`);
    }
  });
}

async function markFailed(
  database: ErpFinancialsTransactionRunner,
  scope: { readonly tenantId: string; readonly companyId: string; readonly bookId?: string; readonly sourceId?: string },
  now: () => IsoDateTime,
  input: { readonly outboxEventId: string; readonly error: string; readonly retryAt?: IsoDateTime; readonly terminal?: boolean }
): Promise<void> {
  await database.transaction(async (client) => {
    const result = await client.query(
      `update "erp_financials"."financial_outbox"
set "status" = 'failed', "available_at" = $5, "lease_expires_at" = null, "last_error" = $6
where "tenant_id" = $1 and "company_id" = $2 and ($3::text is null or "book_id" = $3)
  and "outbox_event_id" = $4 and "status" = 'processing'
  and ($7::text is null or "source_id" = $7)`,
      [
        scope.tenantId,
        scope.companyId,
        scope.bookId,
        input.outboxEventId,
        input.terminal === true ? "9999-12-31T23:59:59.999Z" : (input.retryAt ?? now()),
        input.error.slice(0, 2000),
        scope.sourceId
      ]
    );
    if (result.rowCount !== 1) {
      throw new ErpFinancialsError("terminal_state_conflict", `Outbox event ${input.outboxEventId} is not processing`);
    }
  });
}

function outboxEventFromRow(row: Readonly<Record<string, unknown>>): FinancialOutboxEvent {
  const optional = (field: string): string | undefined => {
    const value = row[field];
    return value === null || value === undefined ? undefined : storedString(value, field);
  };
  const optionalDateTime = (field: string): IsoDateTime | undefined => {
    const value = row[field];
    return value === null || value === undefined ? undefined : storedDateTime(value, field);
  };
  const payload = typeof row.payload === "string" ? (JSON.parse(row.payload) as JsonValue) : (row.payload as JsonValue);
  const bookId = optional("book_id");
  const leaseExpiresAt = optionalDateTime("lease_expires_at");
  const lastError = optional("last_error");
  const publishedAt = optionalDateTime("published_at");
  return {
    outboxEventId: storedString(row.outbox_event_id, "outbox_event_id"),
    tenantId: storedString(row.tenant_id, "tenant_id"),
    companyId: storedString(row.company_id, "company_id"),
    ...(bookId === undefined ? {} : { bookId }),
    sourceId: storedString(row.source_id, "source_id"),
    eventType: storedString(row.event_type, "event_type"),
    aggregateType: storedString(row.aggregate_type, "aggregate_type"),
    aggregateId: storedString(row.aggregate_id, "aggregate_id"),
    idempotencyKey: storedString(row.idempotency_key, "idempotency_key"),
    payload,
    status: storedString(row.status, "status") as FinancialOutboxStatus,
    attemptCount: Number(row.attempt_count),
    availableAt: storedDateTime(row.available_at, "available_at"),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: storedDateTime(row.created_at, "created_at"),
    ...(publishedAt === undefined ? {} : { publishedAt })
  };
}

function storedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Stored ${field} must be a non-empty string`);
  return value;
}

function storedDateTime(value: unknown, field: string): IsoDateTime {
  const dateTime = value instanceof Date ? value.toISOString() : storedString(value, field);
  if (Number.isNaN(Date.parse(dateTime))) throw new Error(`Stored ${field} must be a date-time`);
  return dateTime;
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function normalizeOptional(value: unknown): string | null | undefined {
  return value === null || value === undefined ? null : typeof value === "string" ? value : undefined;
}

function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
