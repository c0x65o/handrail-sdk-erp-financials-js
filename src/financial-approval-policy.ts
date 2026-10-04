import { createHash } from "node:crypto";
import { appendFinancialLifecycleEvent, assertFinancialOperationContext, assertIndependentApproval } from "./financial-lifecycle.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { FinancialLifecycleScope, FinancialOperationContext } from "./financial-lifecycle.js";
import type { ErpFinancialsTransactionRunner } from "./erp-financials-service.js";
import type { AccountingBasis, IsoCurrencyCode } from "./canonical-model.js";
import type { PostgresQueryClient } from "./postgres-storage.js";

/** Stable operation names, selected by trusted server configuration only. */
export type FinancialAction =
  | "journalEntries.postAdjustment" | "journalEntries.reverse" | "journalEntries.void" | "journalEntries.correct" | "journalEntries.replace"
  | "customerPayments.voidAndUnapply"
  | "adjustments.voidIssued" | "adjustments.replaceIssued" | "credits.voidIssued" | "credits.replaceIssued"
  | "refunds.voidIssued" | "refunds.replaceIssued" | "vendorBills.voidIssued" | "vendorBills.replaceIssued"
  | "billPayments.cancel" | "billPayments.voidAndUnapply" | "billPayments.void"
  | "writeOffs.voidIssued" | "writeOffs.replaceIssued" | "deposits.reverse" | "transfers.reverse"
  | "paymentApplications.unapply" | "paymentApplications.void"
  | "invoices.voidDraft" | "invoices.voidIssued"
  | "bankReconciliation.ignore" | "bankReconciliation.unignore" | "bankReconciliation.unmatch"
  | "fiscalPeriods.close" | "fiscalPeriods.reopen" | "fiscalPeriods.setPostingLockDate";

export type FinancialApprovalScope = FinancialLifecycleScope & {
  readonly bookId?: string;
  /** Include the factory's effective settings when constructing confirmation checksums. */
  readonly currencyCode?: IsoCurrencyCode;
  readonly accountingBasis?: AccountingBasis;
  readonly postingPolicy?: "enforce_fiscal_periods" | "legacy_unrestricted";
};
export type AdministratorConfirmation = {
  /** App-owned immutable confirmation record; this is not an independent approval. */
  readonly confirmationRef: string;
  readonly commandChecksum: string;
};
export type AdministratorFinancialGuardInput = FinancialApprovalScope & {
  readonly client: PostgresQueryClient;
  readonly action: FinancialAction;
  readonly phase: "preview" | "confirm";
  readonly command: Readonly<Record<string, unknown>> & { readonly operation: FinancialOperationContext };
  readonly commandChecksum: string;
};
/** Guard must authenticate from server context, lock active company membership and
 * the immutable preview/confirmation through commit, and reject stale evidence.
 * Returning client-supplied claims is NOT a supported guard implementation. */
export type AdministratorFinancialGuard = (input: AdministratorFinancialGuardInput) => Promise<FinancialApprovalScope & {
  readonly actorRef: string;
  readonly requestId: string;
  readonly action: FinancialAction;
  readonly commandChecksum: string;
  readonly active: boolean;
  readonly administrator: boolean;
  readonly confirmed: boolean;
}>;
export type FinancialApprovalPolicy =
  | { readonly mode: "independent" }
  | { readonly mode: "administrator_direct"; readonly actions: readonly FinancialAction[]; readonly guard: AdministratorFinancialGuard };

export type FinancialActionContext = FinancialApprovalScope & {
  readonly database: ErpFinancialsTransactionRunner;
  readonly now: () => string;
  readonly financialApprovalPolicy?: FinancialApprovalPolicy;
};
type Grant = {
  active: boolean;
  readonly scope: FinancialApprovalScope;
  readonly client: PostgresQueryClient;
  readonly audit: { policy: "administrator_direct"; action: FinancialAction; actorRef: string; commandChecksum: string; confirmationRef: string | null };
};
const grants = new WeakMap<FinancialOperationContext, Grant>();

/** Bind a server-created preview to the entire command, real actor, request and
 * scope. The confirmation envelope itself is excluded to avoid a circular hash.
 * This digest does not authenticate anyone or load/validate financial state. */
export function createFinancialActionCommandChecksum(
  scope: FinancialApprovalScope, action: FinancialAction, command: { readonly operation: FinancialOperationContext }
): string {
  const { administratorConfirmation: _confirmation, ...operation } = command.operation;
  void _confirmation;
  return createHash("sha256").update(stable({
    policy: "administrator_direct", scope: scopeCopy(scope), action, command: { ...command, operation }
  })).digest("hex");
}

/** Internal entry-point integration; never exported from the package. */
export function runFinancialAction<C extends FinancialActionContext, I extends { readonly operation: FinancialOperationContext }, R>(
  context: C, action: FinancialAction, input: I, work: (context: C, input: I) => Promise<R>, phase: "preview" | "confirm" = "confirm"
): Promise<R> {
  const policy = context.financialApprovalPolicy;
  if (policy === undefined || policy.mode === "independent") return work(context, input);
  const policyMode: unknown = policy.mode;
  if (policyMode !== "administrator_direct" || !Array.isArray(policy.actions) || typeof policy.guard !== "function") {
    return Promise.reject(denied("Invalid server financial approval policy or missing administrator guard"));
  }
  if (!policy.actions.includes(action)) return work(context, input);
  // Snapshot before the first await. Neither callers nor guard callbacks may
  // mutate the command that the transaction will execute.
  const command = freeze(structuredClone(input));
  assertFinancialOperationContext(command.operation);
  if (command.operation.approverRef !== undefined && command.operation.approverRef !== command.operation.actorRef) {
    return Promise.reject(denied("Administrator-direct confirmation must use the real actor, without a separate approver"));
  }
  const scope = scopeCopy(context);
  const commandChecksum = createFinancialActionCommandChecksum(scope, action, command);
  const confirmation = command.operation.administratorConfirmation;
  if (phase === "confirm" && (!confirmation || typeof confirmation.confirmationRef !== "string" ||
      !confirmation.confirmationRef.trim() || confirmation.commandChecksum !== commandChecksum)) {
    return Promise.reject(denied("Explicit administrator confirmation of this exact command is required"));
  }
  const guard = policy.guard;
  return context.database.transaction(async client => {
    const first = await client.query("select txid_current()::text as transaction_id");
    const second = await client.query("select txid_current()::text as transaction_id");
    if (!first.rows[0]?.transaction_id || first.rows[0].transaction_id !== second.rows[0]?.transaction_id) {
      throw denied("Administrator authorization requires one explicit transaction client");
    }
    const evidence: unknown = await guard({ ...scope, client, action, phase,
      command, commandChecksum });
    if (evidence === null || typeof evidence !== "object") throw denied("Missing administrator attestation");
    const attestation = evidence as Record<string, unknown>;
    if (attestation.active !== true || attestation.administrator !== true ||
        attestation.actorRef !== command.operation.actorRef || attestation.requestId !== command.operation.requestId ||
        attestation.action !== action || attestation.commandChecksum !== commandChecksum || (attestation.tenantId !== scope.tenantId || attestation.companyId !== scope.companyId || attestation.sourceId !== scope.sourceId) ||
        attestation.bookId !== scope.bookId || (phase === "confirm" && attestation.confirmed !== true)) {
      throw denied("Authenticated active company administrator confirmation denied");
    }
    const grant: Grant = { active: true, scope, client, audit: { policy: "administrator_direct", action,
      actorRef: command.operation.actorRef, commandChecksum, confirmationRef: confirmation?.confirmationRef ?? null } };
    grants.set(command.operation, grant);
    try {
      if (phase === "confirm") {
        await appendFinancialLifecycleEvent(client, { ...scope, operation: command.operation,
          aggregateType: "financial_action", aggregateId: command.operation.requestId,
          eventType: "financial_action.administrator_confirmed",
          idempotencyKey: `administrator-confirmation:${action}:${command.operation.requestId}`,
          recordedAt: context.now(), payload: { commandChecksum } });
      }
      return await work({ ...context, database: { transaction: async callback => callback(client) } }, command);
    } finally {
      grant.active = false;
    }
  });
}

export function assertFinancialApproval(scope: FinancialLifecycleScope, operation: FinancialOperationContext): void {
  const grant = grants.get(operation);
  if (grant?.active && sameScope(scope, grant.scope)) { assertFinancialOperationContext(operation); return; }
  assertIndependentApproval(operation);
}

/** Preserve only a live, SDK-issued capability across internal defensive copies. */
export function copyFinancialOperation(operation: FinancialOperationContext): FinancialOperationContext {
  const { administratorConfirmation: _confirmation, ...fields } = operation;
  void _confirmation;
  const copy = structuredClone(fields);
  const grant = grants.get(operation);
  if (grant?.active) grants.set(copy, grant);
  return freeze(copy);
}

export function financialApprovalAudit(client: PostgresQueryClient, scope: FinancialLifecycleScope, operation: FinancialOperationContext): Grant["audit"] | undefined {
  const grant = grants.get(operation);
  return grant?.active && grant.client === client && sameScope(scope, grant.scope) ? grant.audit : undefined;
}
function denied(message: string): ErpFinancialsError { return new ErpFinancialsError("authorization_context_invalid", message); }
function scopeCopy(scope: FinancialApprovalScope): FinancialApprovalScope {
  return { tenantId: scope.tenantId, companyId: scope.companyId, sourceId: scope.sourceId,
    ...(scope.bookId === undefined ? {} : { bookId: scope.bookId }),
    ...(scope.currencyCode === undefined ? {} : { currencyCode: scope.currencyCode }),
    accountingBasis: scope.accountingBasis ?? "accrual", postingPolicy: scope.postingPolicy ?? "enforce_fiscal_periods" };
}
function sameScope(a: FinancialLifecycleScope, b: FinancialLifecycleScope): boolean {
  return a.tenantId === b.tenantId && a.companyId === b.companyId && a.sourceId === b.sourceId;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}
