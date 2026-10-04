import { assertFinancialApproval, financialApprovalAudit, runFinancialAction, type FinancialApprovalPolicy } from "./financial-approval-policy.js";
import { createHash } from "node:crypto";

import { assertSafeSourcePayloadRef } from "./canonical-model.js";
import { appendFinancialOutboxEvent } from "./financial-outbox.js";
import {
  appendFinancialLifecycleEvent,
  assertFinancialOperationContext,
} from "./financial-lifecycle.js";
import { ErpFinancialsError } from "./sdk-errors.js";

import type { DecimalString, IsoCurrencyCode, IsoDate, IsoDateTime, SafeSourcePayloadRef } from "./canonical-model.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { FinancialOperationContext } from "./financial-lifecycle.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

export type BankStatementLineResult = {
  readonly bankStatementLineId: string;
  readonly status: "unmatched" | "matched" | "ignored";
  readonly version: number;
  readonly externalLineId: string;
  readonly postedDate: IsoDate;
  readonly amount: DecimalString;
  readonly currencyCode: IsoCurrencyCode;
};

export type IngestBankStatementLineInput = {
  readonly operation: FinancialOperationContext;
  readonly externalLineId: string;
  readonly bankAccountId: string;
  readonly postedDate: IsoDate;
  /** Signed from the bank account's perspective: deposits positive, withdrawals negative. */
  readonly amount: DecimalString;
  readonly currencyCode?: IsoCurrencyCode;
  readonly description?: string;
  readonly reference?: string;
  readonly sourcePayloadRef?: SafeSourcePayloadRef;
};

export type MatchBankStatementLineInput = {
  readonly operation: FinancialOperationContext;
  readonly bankStatementLineId: string;
  readonly transactionId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly method: "automatic" | "manual";
};

export type UnignoreBankStatementLineInput = {
  readonly operation: FinancialOperationContext;
  readonly bankStatementLineId: string;
  readonly expectedVersion: number;
};

export type BankReconciliationMatchResult = {
  readonly status: "matched" | "already_matched" | "unmatched" | "voided";
  readonly bankReconciliationMatchId: string;
  readonly bankStatementLineId: string;
  readonly transactionId: string;
  readonly matchedAmount: DecimalString;
  readonly method: "automatic" | "manual";
  readonly version: number;
};

export type BankReconciliationService = {
  ingest(input: IngestBankStatementLineInput): Promise<BankStatementLineResult>;
  match(input: MatchBankStatementLineInput): Promise<BankReconciliationMatchResult>;
  unmatch(input: { readonly operation: FinancialOperationContext; readonly bankReconciliationMatchId: string; readonly expectedVersion: number }): Promise<BankReconciliationMatchResult>;
  ignore(input: { readonly operation: FinancialOperationContext; readonly bankStatementLineId: string; readonly expectedVersion: number }): Promise<BankStatementLineResult>;
  unignore(input: UnignoreBankStatementLineInput): Promise<BankStatementLineResult>;
};

type Scope = {
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly now: () => IsoDateTime;
};

export function createBankReconciliationService(input: {
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
  readonly database: ErpFinancialsTransactionRunner;
  readonly tenantId: string;
  readonly companyId: string;
  readonly bookId: string;
  readonly sourceId: string;
  readonly currencyCode: IsoCurrencyCode;
  readonly now?: () => IsoDateTime;
}): BankReconciliationService {
  const scope: Scope = { ...input, now: input.now ?? (() => new Date().toISOString()) };
  for (const [field, value] of Object.entries({
    tenantId: input.tenantId,
    companyId: input.companyId,
    bookId: input.bookId,
    sourceId: input.sourceId
  })) {
    assertNonEmpty(value, field);
  }
  if (!/^[A-Z]{3}$/u.test(input.currencyCode)) {
    throw new ErpFinancialsError("invalid_input", "currencyCode must be a three-letter uppercase ISO currency code");
  }
  return {
    ingest: (command) => ingest(scope, command),
    match: (command) => match(scope, command),
    unmatch: (command) => runFinancialAction(scope, "bankReconciliation.unmatch", command, unmatch),
    ignore: (command) => runFinancialAction(scope, "bankReconciliation.ignore", command, ignore),
    unignore: (command) => runFinancialAction(scope, "bankReconciliation.unignore", command, unignore)
  };
}

async function ingest(scope: Scope, input: IngestBankStatementLineInput): Promise<BankStatementLineResult> {
  assertFinancialOperationContext(input.operation);
  assertNonEmpty(input.externalLineId, "externalLineId");
  assertNonEmpty(input.bankAccountId, "bankAccountId");
  assertDate(input.postedDate, "postedDate");
  const amount = signedMoney(input.amount, "amount");
  const currencyCode = input.currencyCode ?? scope.currencyCode;
  assertCurrency(scope, currencyCode);
  if (input.sourcePayloadRef !== undefined) assertSafeSourcePayloadRef(input.sourcePayloadRef);
  const bankStatementLineId = stableId("bank_line", scope.tenantId, scope.companyId, scope.bookId, input.externalLineId);
  return scope.database.transaction(async (client) => {
    await assertBankScope(client, scope, input.bankAccountId);
    const result = await client.query(
      `insert into "erp_financials"."bank_statement_lines" (
  "bank_statement_line_id", "tenant_id", "company_id", "book_id", "source_id", "bank_account_id", "external_line_id",
  "posted_date", "amount", "currency_code", "description", "reference", "status", "version", "source_payload_ref",
  "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unmatched', 1, $13, $14, $14)
on conflict ("tenant_id", "company_id", "book_id", "external_line_id") do nothing returning *`,
      [bankStatementLineId, scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, input.bankAccountId,
        input.externalLineId, input.postedDate, amount, currencyCode, input.description, input.reference,
        input.sourcePayloadRef === undefined ? undefined : JSON.stringify(input.sourcePayloadRef), scope.now()]
    );
    let row = result.rows[0];
    if (row === undefined) {
      const existing = await client.query(
        `select * from "erp_financials"."bank_statement_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "external_line_id" = $4 for key share`,
        [scope.tenantId, scope.companyId, scope.bookId, input.externalLineId]
      );
      row = requiredRow(existing.rows[0], "bank statement line");
      if (row.bank_statement_line_id !== bankStatementLineId || row.bank_account_id !== input.bankAccountId ||
        date(row.posted_date, "posted_date") !== input.postedDate || money(row.amount, "amount") !== amount ||
        row.currency_code !== currencyCode || optionalString(row.description) !== input.description ||
        optionalString(row.reference) !== input.reference ||
        stableJson(parsedOptionalJson(row.source_payload_ref)) !== stableJson(input.sourcePayloadRef)) {
        throw new ErpFinancialsError("idempotency_conflict", `Bank line ${input.externalLineId} already has different content`);
      }
    }
    const lifecycleEvent = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
      aggregateType: "bank_statement_line", aggregateId: bankStatementLineId,
      eventType: "bank_statement_line.ingested", idempotencyKey: `bank-line:${input.externalLineId}:ingested`,
      payload: { amount, bankAccountId: input.bankAccountId, postedDate: input.postedDate }
    }));
    await outbox(client, scope, "bank_statement_line.ingested", "bank_statement_line", bankStatementLineId,
      `bank-line:${input.externalLineId}:outbox:ingested`, { amount, bankStatementLineId });
    void lifecycleEvent;
    return bankLineResult(row);
  });
}

async function match(scope: Scope, input: MatchBankStatementLineInput): Promise<BankReconciliationMatchResult> {
  assertFinancialOperationContext(input.operation);
  assertVersion(input.expectedVersion);
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  const method: unknown = input.method;
  if (method !== "automatic" && method !== "manual") {
    throw new ErpFinancialsError("invalid_input", "method must be automatic or manual");
  }
  if (input.method === "manual" && input.operation.actorRef.trim().length === 0) {
    throw new ErpFinancialsError("authorization_context_invalid", "Manual reconciliation requires an actorRef");
  }
  const matchId = stableId("bank_match", scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey);
  return scope.database.transaction(async (client) => {
    const existing = await client.query(
      `select * from "erp_financials"."bank_reconciliation_matches"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "idempotency_key" = $4 for key share`,
      [scope.tenantId, scope.companyId, scope.bookId, input.idempotencyKey]
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      if (row.bank_statement_line_id !== input.bankStatementLineId || row.transaction_id !== input.transactionId || row.method !== input.method) {
        throw new ErpFinancialsError("idempotency_conflict", `Reconciliation key ${input.idempotencyKey} has different content`);
      }
      if (row.status !== "matched") throw new ErpFinancialsError("terminal_state_conflict", `Reconciliation match is ${String(row.status)}`);
      return matchResult(row, "already_matched");
    }
    const lineResult = await client.query(
      `select * from "erp_financials"."bank_statement_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4 for update`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId]
    );
    const line = requiredRow(lineResult.rows[0], "bank statement line");
    if (line.status !== "unmatched") throw new ErpFinancialsError("reconciliation_conflict", `Bank line is already ${String(line.status)}`);
    if (integer(line.version, "version") !== input.expectedVersion) throw concurrency(input.bankStatementLineId, input.expectedVersion);
    const transactionResult = await client.query(
      `select transaction."transaction_id", transaction."currency_code", transaction."transaction_date",
  coalesce(sum(posting."net_amount") filter (where posting."account_id" = $5), 0) as "bank_amount"
from "erp_financials"."transactions" transaction
join "erp_financials"."ledger_postings" posting
  on posting."tenant_id" = transaction."tenant_id" and posting."source_id" = transaction."source_id" and posting."transaction_id" = transaction."transaction_id"
where transaction."tenant_id" = $1 and transaction."source_id" = $2 and transaction."transaction_id" = $3
  and transaction."status" = 'posted' and posting."currency_code" = $4
group by transaction."transaction_id", transaction."currency_code", transaction."transaction_date"
`,
      [scope.tenantId, scope.sourceId, input.transactionId, scope.currencyCode, line.bank_account_id]
    );
    const transaction = transactionResult.rows[0];
    if (transaction === undefined) throw new ErpFinancialsError("missing_document", `Transaction ${input.transactionId} does not exist in the bank line source`);
    if (transaction.currency_code !== line.currency_code || money(transaction.bank_amount, "bank_amount") !== money(line.amount, "amount")) {
      throw new ErpFinancialsError("reconciliation_conflict", "The transaction's bank-account posting must exactly match the statement line amount and currency", {
        details: { bankStatementLineId: input.bankStatementLineId, transactionId: input.transactionId }
      });
    }
    const lifecycleEvent = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
      aggregateType: "bank_reconciliation_match", aggregateId: matchId,
      eventType: "bank_reconciliation.matched", idempotencyKey: `bank-match:${input.idempotencyKey}:matched`,
      payload: { bankStatementLineId: input.bankStatementLineId, method: input.method, transactionId: input.transactionId }
    }));
    const inserted = await client.query(
      `insert into "erp_financials"."bank_reconciliation_matches" (
  "bank_reconciliation_match_id", "tenant_id", "company_id", "book_id", "source_id", "bank_statement_line_id",
  "transaction_id", "matched_amount", "method", "status", "version", "idempotency_key", "lifecycle_event_id",
  "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, $6, $7, abs($8::numeric), $9, 'matched', 1, $10, $11, $12, $12) returning *`,
      [matchId, scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, input.bankStatementLineId,
        input.transactionId, line.amount, input.method, input.idempotencyKey, lifecycleEvent.eventId, scope.now()]
    );
    const updated = await client.query(
      `update "erp_financials"."bank_statement_lines" set "status" = 'matched', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4
  and "status" = 'unmatched' and "version" = $6 returning "bank_statement_line_id"`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId, scope.now(), input.expectedVersion]
    );
    if (updated.rows[0] === undefined) throw concurrency(input.bankStatementLineId, input.expectedVersion);
    await outbox(client, scope, "bank_reconciliation.matched", "bank_reconciliation_match", matchId,
      `bank-match:${input.idempotencyKey}:outbox:matched`, { bankStatementLineId: input.bankStatementLineId, transactionId: input.transactionId });
    return matchResult(requiredRow(inserted.rows[0], "bank reconciliation match"), "matched");
  });
}

async function unmatch(
  scope: Scope,
  input: { readonly operation: FinancialOperationContext; readonly bankReconciliationMatchId: string; readonly expectedVersion: number }
): Promise<BankReconciliationMatchResult> {
  assertFinancialApproval(scope, input.operation);
  assertVersion(input.expectedVersion);
  return scope.database.transaction(async (client) => {
    const result = await client.query(
      `select * from "erp_financials"."bank_reconciliation_matches"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_reconciliation_match_id" = $4 for update`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankReconciliationMatchId]
    );
    const row = requiredRow(result.rows[0], "bank reconciliation match");
    if (row.status === "unmatched") return matchResult(row, "unmatched");
    if (row.status !== "matched") throw new ErpFinancialsError("terminal_state_conflict", `Reconciliation match is ${String(row.status)}`);
    if (integer(row.version, "version") !== input.expectedVersion) throw concurrency(input.bankReconciliationMatchId, input.expectedVersion);
    const lifecycleEvent = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
      aggregateType: "bank_reconciliation_match", aggregateId: input.bankReconciliationMatchId,
      eventType: "bank_reconciliation.unmatched",
      idempotencyKey: `bank-match:${input.bankReconciliationMatchId}:unmatched:v${String(input.expectedVersion)}`,
      payload: { bankStatementLineId: string(row.bank_statement_line_id, "bank_statement_line_id"), priorVersion: input.expectedVersion },
      priorEventId: string(row.lifecycle_event_id, "lifecycle_event_id")
    }));
    const updated = await client.query(
      `update "erp_financials"."bank_reconciliation_matches"
set "status" = 'unmatched', "version" = "version" + 1, "lifecycle_event_id" = $5, "updated_at" = $6
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_reconciliation_match_id" = $4
  and "status" = 'matched' and "version" = $7 returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankReconciliationMatchId, lifecycleEvent.eventId, scope.now(), input.expectedVersion]
    );
    if (updated.rows[0] === undefined) throw concurrency(input.bankReconciliationMatchId, input.expectedVersion);
    await client.query(
      `update "erp_financials"."bank_statement_lines" set "status" = 'unmatched', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4 and "status" = 'matched'`,
      [scope.tenantId, scope.companyId, scope.bookId, row.bank_statement_line_id, scope.now()]
    );
    await outbox(client, scope, "bank_reconciliation.unmatched", "bank_reconciliation_match", input.bankReconciliationMatchId,
      `bank-match:${input.bankReconciliationMatchId}:outbox:unmatched:v${String(input.expectedVersion)}`,
      { bankStatementLineId: string(row.bank_statement_line_id, "bank_statement_line_id") });
    return matchResult(requiredRow(updated.rows[0], "unmatched reconciliation"), "unmatched");
  });
}

async function ignore(
  scope: Scope,
  input: { readonly operation: FinancialOperationContext; readonly bankStatementLineId: string; readonly expectedVersion: number }
): Promise<BankStatementLineResult> {
  assertFinancialApproval(scope, input.operation);
  assertVersion(input.expectedVersion);
  return scope.database.transaction(async (client) => {
    if (financialApprovalAudit(client, scope, input.operation) !== undefined) {
      const locked = await client.query(
        `select * from "erp_financials"."bank_statement_lines"
where "tenant_id"=$1 and "company_id"=$2 and "book_id"=$3 and "bank_statement_line_id"=$4 and "source_id"=$5 for update`,
        [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId, scope.sourceId]
      );
      const line = requiredRow(locked.rows[0], "bank statement line");
      const event = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
        aggregateType: "bank_statement_line", aggregateId: input.bankStatementLineId,
        eventType: "bank_statement_line.ignored",
        idempotencyKey: `bank-line:${input.bankStatementLineId}:ignored:v${String(input.expectedVersion)}`,
        payload: { priorVersion: input.expectedVersion }
      }));
      if (event.status === "already_recorded") {
        if (line.status !== "ignored" || integer(line.version, "version") !== input.expectedVersion + 1) {
          throw new ErpFinancialsError("idempotency_conflict", "Confirmed ignore no longer has its stable resulting state");
        }
        return bankLineResult(line);
      }
    }
    const result = await client.query(
      `update "erp_financials"."bank_statement_lines" set "status" = 'ignored', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4
  and "status" = 'unmatched' and "version" = $6 returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId, scope.now(), input.expectedVersion]
    );
    const row = result.rows[0];
    if (row === undefined) throw new ErpFinancialsError("reconciliation_conflict", "Only an unmatched bank line at the expected version can be ignored");
    const lifecycleEvent = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
      aggregateType: "bank_statement_line", aggregateId: input.bankStatementLineId,
      eventType: "bank_statement_line.ignored",
      idempotencyKey: `bank-line:${input.bankStatementLineId}:ignored:v${String(input.expectedVersion)}`,
      payload: { priorVersion: input.expectedVersion }
    }));
    await outbox(client, scope, "bank_statement_line.ignored", "bank_statement_line", input.bankStatementLineId,
      `bank-line:${input.bankStatementLineId}:outbox:ignored:v${String(input.expectedVersion)}`,
      { bankStatementLineId: input.bankStatementLineId });
    void lifecycleEvent;
    return bankLineResult(row);
  });
}

async function unignore(scope: Scope, input: UnignoreBankStatementLineInput): Promise<BankStatementLineResult> {
  assertFinancialApproval(scope, input.operation);
  if (input.operation.reasonDetail === undefined) {
    throw new ErpFinancialsError(
      "authorization_context_invalid",
      "operation.reasonDetail is required when reopening an ignored bank statement line"
    );
  }
  assertVersion(input.expectedVersion);
  const lifecycleIdempotencyKey = `bank-line:${input.bankStatementLineId}:unignored:request:${input.operation.requestId}`;
  const outboxIdempotencyKey = `bank-line:${input.bankStatementLineId}:outbox:unignored:request:${input.operation.requestId}`;
  const payload = {
    priorVersion: input.expectedVersion,
    resultingVersion: input.expectedVersion + 1
  } as const;
  return scope.database.transaction(async (client) => {
    const result = await client.query(
      `select * from "erp_financials"."bank_statement_lines"
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4 for update`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId]
    );
    const row = requiredRow(result.rows[0], "bank statement line");
    const lifecycleEvent = await appendFinancialLifecycleEvent(client, lifecycle(scope, input.operation, {
      aggregateType: "bank_statement_line",
      aggregateId: input.bankStatementLineId,
      eventType: "bank_statement_line.unignored",
      idempotencyKey: lifecycleIdempotencyKey,
      payload
    }));
    if (lifecycleEvent.status === "already_recorded") {
      if (row.status !== "unmatched" || integer(row.version, "version") !== input.expectedVersion + 1) {
        throw new ErpFinancialsError(
          "idempotency_conflict",
          `Bank statement line reopen request ${input.operation.requestId} no longer has its stable resulting state`
        );
      }
      await outbox(
        client,
        scope,
        "bank_statement_line.unignored",
        "bank_statement_line",
        input.bankStatementLineId,
        outboxIdempotencyKey,
        { bankStatementLineId: input.bankStatementLineId, resultingVersion: input.expectedVersion + 1 }
      );
      return bankLineResult(row);
    }
    if (integer(row.version, "version") !== input.expectedVersion) {
      throw concurrency(input.bankStatementLineId, input.expectedVersion);
    }
    if (row.status !== "ignored") {
      throw new ErpFinancialsError("reconciliation_conflict", "Only an ignored bank statement line can be reopened");
    }
    const updated = await client.query(
      `update "erp_financials"."bank_statement_lines"
set "status" = 'unmatched', "version" = "version" + 1, "updated_at" = $5
where "tenant_id" = $1 and "company_id" = $2 and "book_id" = $3 and "bank_statement_line_id" = $4
  and "status" = 'ignored' and "version" = $6 returning *`,
      [scope.tenantId, scope.companyId, scope.bookId, input.bankStatementLineId, scope.now(), input.expectedVersion]
    );
    const reopened = updated.rows[0];
    if (reopened === undefined) throw concurrency(input.bankStatementLineId, input.expectedVersion);
    await outbox(
      client,
      scope,
      "bank_statement_line.unignored",
      "bank_statement_line",
      input.bankStatementLineId,
      outboxIdempotencyKey,
      { bankStatementLineId: input.bankStatementLineId, resultingVersion: input.expectedVersion + 1 }
    );
    return bankLineResult(reopened);
  });
}

async function assertBankScope(client: PostgresQueryClient, scope: Scope, accountId: string): Promise<void> {
  const result = await client.query(
    `select account."account_id", book."base_currency_code"
from "erp_financials"."accounts" account
join "erp_financials"."reporting_book_sources" source
  on source."tenant_id" = $1 and source."company_id" = $2 and source."book_id" = $3 and source."source_id" = account."source_id"
join "erp_financials"."reporting_books" book
  on book."tenant_id" = source."tenant_id" and book."company_id" = source."company_id" and book."book_id" = source."book_id"
where account."tenant_id" = $1 and account."source_id" = $4 and account."account_id" = $5 and account."active" and book."status" = 'active'`,
    [scope.tenantId, scope.companyId, scope.bookId, scope.sourceId, accountId]
  );
  const row = result.rows[0];
  if (row === undefined) throw new ErpFinancialsError("missing_account", `Bank account ${accountId} is missing, inactive, or outside the reporting book`);
  if (row.base_currency_code !== scope.currencyCode) throw new ErpFinancialsError("currency_not_supported", "Bank scope currency differs from reporting book base currency");
}

function lifecycle(
  scope: Scope,
  operation: FinancialOperationContext,
  input: { readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly idempotencyKey: string; readonly payload: import("./canonical-model.js").JsonValue; readonly priorEventId?: string }
) {
  return { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId, operation, recordedAt: scope.now(), ...input };
}

async function outbox(
  client: PostgresQueryClient,
  scope: Scope,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  idempotencyKey: string,
  payload: import("./canonical-model.js").JsonValue
): Promise<void> {
  await appendFinancialOutboxEvent(client, {
    tenantId: scope.tenantId, companyId: scope.companyId, bookId: scope.bookId, sourceId: scope.sourceId,
    eventType, aggregateType, aggregateId, idempotencyKey, payload, availableAt: scope.now()
  });
}

function bankLineResult(row: Readonly<Record<string, unknown>>): BankStatementLineResult {
  return {
    bankStatementLineId: string(row.bank_statement_line_id, "bank_statement_line_id"),
    status: string(row.status, "status") as BankStatementLineResult["status"],
    version: integer(row.version, "version"),
    externalLineId: string(row.external_line_id, "external_line_id"),
    postedDate: date(row.posted_date, "posted_date"),
    amount: money(row.amount, "amount"),
    currencyCode: string(row.currency_code, "currency_code")
  };
}

function matchResult(row: Readonly<Record<string, unknown>>, status: BankReconciliationMatchResult["status"]): BankReconciliationMatchResult {
  return {
    status,
    bankReconciliationMatchId: string(row.bank_reconciliation_match_id, "bank_reconciliation_match_id"),
    bankStatementLineId: string(row.bank_statement_line_id, "bank_statement_line_id"),
    transactionId: string(row.transaction_id, "transaction_id"),
    matchedAmount: money(row.matched_amount, "matched_amount"),
    method: string(row.method, "method") as BankReconciliationMatchResult["method"],
    version: integer(row.version, "version")
  };
}

function concurrency(id: string, expectedVersion: number): ErpFinancialsError {
  return new ErpFinancialsError("optimistic_concurrency_conflict", `Record ${id} is no longer at version ${String(expectedVersion)}`, {
    retryable: true, details: { expectedVersion, recordId: id }
  });
}

function assertCurrency(scope: Scope, currencyCode: string): void {
  if (currencyCode !== scope.currencyCode) throw new ErpFinancialsError("currency_not_supported", `Currency ${currencyCode} is outside this single-currency book`);
}

function assertVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new ErpFinancialsError("invalid_input", "expectedVersion must be a positive integer");
}

function assertDate(value: string, field: string): asserts value is IsoDate {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ErpFinancialsError("invalid_input", `${field} must be a valid ISO date`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ErpFinancialsError("invalid_input", `${field} must not be empty`);
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update([prefix, ...parts].join("\u0000")).digest("hex").slice(0, 24)}`;
}

function requiredRow(row: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  if (row === undefined) throw new ErpFinancialsError("missing_document", `Missing ${field}`);
  return row;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Stored ${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Stored optional field must be a string");
  return value;
}

function date(value: unknown, field: string): IsoDate {
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : string(value, field).slice(0, 10);
  assertDate(result, field);
  return result;
}

function signedMoney(value: unknown, field: string): DecimalString {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/u.test(value)) throw new ErpFinancialsError("invalid_input", `${field} must be a signed decimal with at most two fractional digits`);
  const normalized = money(value, field);
  if (normalized === "0.00" || normalized === "-0.00") throw new ErpFinancialsError("invalid_input", `${field} must not be zero`);
  return normalized;
}

function money(value: unknown, field: string): DecimalString {
  const raw = typeof value === "number" ? String(value) : string(value, field);
  if (!/^-?\d+(?:\.\d+)?$/u.test(raw)) throw new Error(`Stored ${field} must be decimal`);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  return `${negative ? "-" : ""}${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function parsedOptionalJson(value: unknown): import("./canonical-model.js").JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return (typeof value === "string" ? JSON.parse(value) : value) as import("./canonical-model.js").JsonValue;
}

function stableJson(value: import("./canonical-model.js").JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries = value as readonly import("./canonical-model.js").JsonValue[];
    return `[${entries.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, import("./canonical-model.js").JsonValue>>;
  return `{${Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function integer(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(result)) throw new Error(`Stored ${field} must be an integer`);
  return result;
}
