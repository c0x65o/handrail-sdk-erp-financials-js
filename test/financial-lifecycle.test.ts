import { describe, expect, it } from "vitest";

import {
  FinancialLifecycleIdempotencyConflictError,
  appendFinancialLifecycleEvent,
  assertFinancialOperationContext,
  assertIndependentApproval
} from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

describe("financial authorization and lifecycle context", () => {
  it("requires actor, request, correlation, reason, and timestamp fields", () => {
    expect(() => { assertFinancialOperationContext(operation()); }).not.toThrow();
    expect(() => { assertFinancialOperationContext({ ...operation(), requestId: "" }); }).toThrow(
      "operation.requestId must not be empty"
    );
    expect(() => { assertFinancialOperationContext({ ...operation(), occurredAt: "not-a-date" }); }).toThrow(
      "operation.occurredAt must be a valid ISO date-time"
    );
  });

  it("supports independently approved high-risk operations without owning host permissions", () => {
    expect(() =>
      { assertIndependentApproval({ ...operation(), approverRef: "user:controller" }); }
    ).not.toThrow();
    expect(() => { assertIndependentApproval(operation()); }).toThrow("operation.approverRef is required");
    expect(() => { assertIndependentApproval({ ...operation(), approverRef: "user:ray" }); }).toThrow(
      "operation.approverRef must differ"
    );
  });

  it("appends one immutable event and treats an identical retry as the same event", async () => {
    const client = new LifecycleClient();
    const input = lifecycleInput();

    const first = await appendFinancialLifecycleEvent(client, input);
    const retry = await appendFinancialLifecycleEvent(client, input);

    expect(first.status).toBe("recorded");
    expect(first.eventId).toMatch(/^event_[a-f0-9]{24}$/);
    expect(retry).toEqual({ ...first, status: "already_recorded" });
    expect(client.events).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("on conflict");
  });

  it("fails closed when an idempotency key is reused for different lifecycle content", async () => {
    const client = new LifecycleClient();
    await appendFinancialLifecycleEvent(client, lifecycleInput());

    await expect(
      appendFinancialLifecycleEvent(client, {
        ...lifecycleInput(),
        eventType: "journal_entry.reversed"
      })
    ).rejects.toBeInstanceOf(FinancialLifecycleIdempotencyConflictError);

    await expect(
      appendFinancialLifecycleEvent(client, {
        ...lifecycleInput(),
        operation: { ...operation(), actorRef: "user:other" }
      })
    ).rejects.toBeInstanceOf(FinancialLifecycleIdempotencyConflictError);
  });

  it("explicit transport replay preserves original audit metadata and never relaxes business or authorization identity", async () => {
    const client = new LifecycleClient(), input = lifecycleInput();
    const first = await appendFinancialLifecycleEvent(client, input);
    const transport = { ...input.operation, requestId: "retry-request", correlationId: "retry-correlation", occurredAt: "2026-09-01T12:00:00.000Z" };
    await expect(appendFinancialLifecycleEvent(client, { ...input, operation: transport })).rejects.toBeInstanceOf(FinancialLifecycleIdempotencyConflictError);
    const before = structuredClone(client.events);
    await expect(appendFinancialLifecycleEvent(client, { ...input, operation: transport, allowTransportReplay: true })).resolves.toEqual({ ...first, status: "already_recorded" });
    for (const changed of [{ actorRef: "other" }, { approverRef: "other" }, { reasonCode: "changed" }, { reasonDetail: "changed" }]) {
      await expect(appendFinancialLifecycleEvent(client, { ...input, operation: { ...transport, ...changed }, allowTransportReplay: true })).rejects.toBeInstanceOf(FinancialLifecycleIdempotencyConflictError);
    }
    await expect(appendFinancialLifecycleEvent(client, { ...input, operation: transport, payload: { changed: true }, allowTransportReplay: true })).rejects.toBeInstanceOf(FinancialLifecycleIdempotencyConflictError);
    expect(client.events).toEqual(before);
  });

  it("rejects credential-shaped lifecycle payloads before querying Postgres", async () => {
    const client = new LifecycleClient();

    await expect(
      appendFinancialLifecycleEvent(client, {
        ...lifecycleInput(),
        payload: { access_token: "must-not-be-stored" }
      })
    ).rejects.toThrow("credential-like field is not allowed");
    expect(client.calls).toHaveLength(0);
  });
});

class LifecycleClient implements PostgresQueryClient {
  readonly calls: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
  readonly events: Record<string, unknown>[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });
    if (sql.startsWith("insert into")) {
      const idempotencyKey = String(params[15]);
      if (this.events.some((event) => event.idempotency_key === idempotencyKey)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const event = {
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
        idempotency_key: idempotencyKey,
        payload_checksum: params[16],
        prior_event_id: params[18] ?? null
      };
      this.events.push(event);
      return Promise.resolve({ rows: [event] as unknown as readonly Row[], rowCount: 1 });
    }
    const event = this.events.find((candidate) => candidate.idempotency_key === params[3]);
    return Promise.resolve({ rows: (event === undefined ? [] : [event]) as unknown as readonly Row[] });
  }
}

function operation() {
  return {
    actorRef: "user:ray",
    requestId: "request:journal:1",
    correlationId: "correlation:month-close",
    reasonCode: "correct_classification",
    reasonDetail: "Move setup fees to their dedicated revenue account",
    occurredAt: "2026-08-12T15:00:00.000Z"
  } as const;
}

function lifecycleInput() {
  return {
    tenantId: "tenant_1",
    companyId: "company_1",
    sourceId: "source_1",
    aggregateType: "journal_entry",
    aggregateId: "transaction_1",
    eventType: "journal_entry.posted",
    idempotencyKey: "journal-entry:1:posted",
    operation: operation(),
    recordedAt: "2026-08-12T15:00:01.000Z",
    payload: { transactionId: "transaction_1", amount: "100.00" }
  } as const;
}
