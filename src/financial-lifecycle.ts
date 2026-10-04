import { financialApprovalAudit, type AdministratorConfirmation } from "./financial-approval-policy.js";
import { createHash } from "node:crypto";

import { assertNoCredentialKeys } from "./canonical-model.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { IsoDateTime, JsonValue } from "./canonical-model.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

export type FinancialOperationContext = {
  readonly administratorConfirmation?: AdministratorConfirmation;
  readonly actorRef: string;
  readonly approverRef?: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly reasonDetail?: string;
  readonly occurredAt: IsoDateTime;
};

export type FinancialLifecycleScope = {
  readonly tenantId: string;
  readonly companyId: string;
  readonly sourceId: string;
};

export type AppendFinancialLifecycleEventInput = FinancialLifecycleScope & {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly operation: FinancialOperationContext;
  readonly payload?: JsonValue;
  readonly priorEventId?: string;
  readonly recordedAt: IsoDateTime;
};

export type FinancialLifecycleEventResult = {
  readonly eventId: string;
  readonly status: "recorded" | "already_recorded";
  readonly payloadChecksum: string;
};

type StoredLifecycleRow = Record<string, unknown> & {
  readonly event_id?: unknown;
  readonly aggregate_type?: unknown;
  readonly aggregate_id?: unknown;
  readonly event_type?: unknown;
  readonly actor_ref?: unknown;
  readonly approver_ref?: unknown;
  readonly request_id?: unknown;
  readonly correlation_id?: unknown;
  readonly reason_code?: unknown;
  readonly reason_detail?: unknown;
  readonly occurred_at?: unknown;
  readonly payload_checksum?: unknown;
  readonly prior_event_id?: unknown;
};

export class FinancialLifecycleIdempotencyConflictError extends ErpFinancialsError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      "idempotency_conflict",
      `Financial lifecycle idempotency key ${idempotencyKey} is already associated with a different event`,
      { details: { idempotencyKey } }
    );
    this.name = "FinancialLifecycleIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    Object.setPrototypeOf(this, FinancialLifecycleIdempotencyConflictError.prototype);
  }
}

export function assertFinancialOperationContext(context: FinancialOperationContext): void {
  assertNonEmpty(context.actorRef, "operation.actorRef", "authorization_context_invalid");
  assertNonEmpty(context.requestId, "operation.requestId", "authorization_context_invalid");
  assertNonEmpty(context.correlationId, "operation.correlationId", "authorization_context_invalid");
  assertNonEmpty(context.reasonCode, "operation.reasonCode", "authorization_context_invalid");
  if (context.approverRef !== undefined) {
    assertNonEmpty(context.approverRef, "operation.approverRef", "authorization_context_invalid");
  }
  if (context.reasonDetail !== undefined) {
    assertNonEmpty(context.reasonDetail, "operation.reasonDetail", "authorization_context_invalid");
  }
  assertIsoDateTime(context.occurredAt, "operation.occurredAt", "authorization_context_invalid");
}

export function assertIndependentApproval(context: FinancialOperationContext): void {
  assertFinancialOperationContext(context);
  if (context.approverRef === undefined) {
    throw new ErpFinancialsError("authorization_context_invalid", "operation.approverRef is required for this financial operation");
  }
  if (context.approverRef === context.actorRef) {
    throw new ErpFinancialsError("authorization_context_invalid", "operation.approverRef must differ from operation.actorRef");
  }
}

export async function appendFinancialLifecycleEvent(
  client: PostgresQueryClient,
  input: AppendFinancialLifecycleEventInput
): Promise<FinancialLifecycleEventResult> {
  assertScope(input);
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.aggregateType, "aggregateType");
  assertNonEmpty(input.aggregateId, "aggregateId");
  assertNonEmpty(input.eventType, "eventType");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertIsoDateTime(input.recordedAt, "recordedAt");
  if (input.priorEventId !== undefined) {
    assertNonEmpty(input.priorEventId, "priorEventId");
  }
  const audit = financialApprovalAudit(client, input, input.operation);
  const originalPayload = input.payload ?? {};
  const payload = audit === undefined ? originalPayload : withApprovalAudit(originalPayload, audit);
  assertNoCredentialKeys(payload);
  const payloadChecksum = checksum(payload);
  const eventId = lifecycleEventId(input, payloadChecksum);

  const inserted = await client.query<StoredLifecycleRow>(
    `insert into "erp_financials"."financial_lifecycle_events" (
  "event_id", "tenant_id", "company_id", "source_id", "aggregate_type", "aggregate_id", "event_type",
  "actor_ref", "approver_ref", "request_id", "correlation_id", "reason_code", "reason_detail",
  "occurred_at", "recorded_at", "idempotency_key", "payload_checksum", "payload", "prior_event_id"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
on conflict ("tenant_id", "company_id", "source_id", "idempotency_key") do nothing
returning "event_id", "aggregate_type", "aggregate_id", "event_type", "payload_checksum"`,
    [
      eventId,
      input.tenantId,
      input.companyId,
      input.sourceId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.operation.actorRef,
      input.operation.approverRef,
      input.operation.requestId,
      input.operation.correlationId,
      input.operation.reasonCode,
      input.operation.reasonDetail,
      input.operation.occurredAt,
      input.recordedAt,
      input.idempotencyKey,
      payloadChecksum,
      JSON.stringify(payload),
      input.priorEventId
    ]
  );

  if (inserted.rows[0] !== undefined) {
    return { eventId, status: "recorded", payloadChecksum };
  }

  const existing = await client.query<StoredLifecycleRow>(
    `select "event_id", "aggregate_type", "aggregate_id", "event_type", "actor_ref", "approver_ref",
  "request_id", "correlation_id", "reason_code", "reason_detail", "occurred_at", "payload_checksum", "prior_event_id"
from "erp_financials"."financial_lifecycle_events"
where "tenant_id" = $1 and "company_id" = $2 and "source_id" = $3 and "idempotency_key" = $4
for key share`,
    [input.tenantId, input.companyId, input.sourceId, input.idempotencyKey]
  );
  const row = existing.rows[0];
  if (
    row === undefined ||
    row.event_id !== eventId ||
    row.aggregate_type !== input.aggregateType ||
    row.aggregate_id !== input.aggregateId ||
    row.event_type !== input.eventType ||
    row.actor_ref !== input.operation.actorRef ||
    normalizeNullable(row.approver_ref) !== normalizeNullable(input.operation.approverRef) ||
    row.request_id !== input.operation.requestId ||
    row.correlation_id !== input.operation.correlationId ||
    row.reason_code !== input.operation.reasonCode ||
    normalizeNullable(row.reason_detail) !== normalizeNullable(input.operation.reasonDetail) ||
    normalizeDateTime(row.occurred_at) !== normalizeDateTime(input.operation.occurredAt) ||
    row.payload_checksum !== payloadChecksum ||
    normalizeNullable(row.prior_event_id) !== normalizeNullable(input.priorEventId)
  ) {
    throw new FinancialLifecycleIdempotencyConflictError(input.idempotencyKey);
  }
  return { eventId, status: "already_recorded", payloadChecksum };
}

function normalizeNullable(value: unknown): string | null | undefined {
  return value === undefined || value === null ? null : typeof value === "string" ? value : undefined;
}

function normalizeDateTime(value: unknown): string | undefined {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return parsed === undefined || Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function lifecycleEventId(input: AppendFinancialLifecycleEventInput, payloadChecksum: string): string {
  return `event_${createHash("sha256")
    .update(
      [
        input.tenantId,
        input.companyId,
        input.sourceId,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        input.idempotencyKey,
        payloadChecksum
      ].join("\u0000")
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function checksum(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function assertScope(scope: FinancialLifecycleScope): void {
  assertNonEmpty(scope.tenantId, "tenantId");
  assertNonEmpty(scope.companyId, "companyId");
  assertNonEmpty(scope.sourceId, "sourceId");
}

function assertNonEmpty(
  value: string,
  field: string,
  code: "authorization_context_invalid" | "invalid_input" = "invalid_input"
): void {
  if (value.trim().length === 0) {
    throw new ErpFinancialsError(code, `${field} must not be empty`);
  }
}

function assertIsoDateTime(
  value: string,
  field: string,
  code: "authorization_context_invalid" | "invalid_input" = "invalid_input"
): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ErpFinancialsError(code, `${field} must be a valid ISO date-time`);
  }
}

function withApprovalAudit(payload: JsonValue, audit: JsonValue): JsonValue {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? Object.assign({}, payload, { financialApproval: audit })
    : { data: payload, financialApproval: audit };
}
