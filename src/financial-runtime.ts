import { ErpFinancialsError } from "./sdk-errors.js";

import type { IsoDateTime } from "./canonical-model.js";
import type { FinancialOutboxEvent, FinancialOutboxService } from "./financial-outbox.js";

export type FinancialRuntimeHandlers = {
  /** Rebuild source rollups/snapshots or invalidate an application cache. */
  readonly onLedgerChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onInvoiceChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onPaymentChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onAdjustmentChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onVendorBillChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onSubledgerDocumentChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onBankReconciliationChanged?: (event: FinancialOutboxEvent) => Promise<void>;
  readonly onEvent?: (event: FinancialOutboxEvent) => Promise<void>;
};

export type FinancialRuntimeRunResult = {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly eventIds: readonly string[];
};

export type FinancialRuntime = {
  runOnce(input?: { readonly limit?: number; readonly leaseSeconds?: number }): Promise<FinancialRuntimeRunResult>;
};

/**
 * Delivers the transactional financial outbox with leases, bounded batches,
 * retry scheduling, and event-family routing. This is intentionally scheduler
 * neutral: a host cron, queue worker, or serverless timer only calls runOnce.
 */
export function createFinancialRuntime(input: {
  readonly outbox: FinancialOutboxService;
  readonly handlers: FinancialRuntimeHandlers;
  readonly now?: () => IsoDateTime;
  readonly retryDelaySeconds?: (attemptCount: number) => number;
}): FinancialRuntime {
  const now = input.now ?? (() => new Date().toISOString());
  const retryDelay = input.retryDelaySeconds ?? defaultRetryDelaySeconds;
  return {
    async runOnce(request = {}) {
      const events = await input.outbox.claim(request);
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          const handler = handlerFor(input.handlers, event);
          if (handler === undefined) {
            throw new ErpFinancialsError("unsupported_operation", `No financial runtime handler accepts ${event.eventType}`);
          }
          await handler(event);
          await input.outbox.markPublished(event.outboxEventId);
          published += 1;
        } catch (error) {
          const delaySeconds = retryDelay(event.attemptCount);
          if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) {
            throw new ErpFinancialsError("invalid_input", "retryDelaySeconds must return an integer from 1 to 86400", {
              cause: error
            });
          }
          await input.outbox.markFailed({
            outboxEventId: event.outboxEventId,
            error: safeError(error),
            retryAt: new Date(Date.parse(now()) + delaySeconds * 1000).toISOString()
          });
          failed += 1;
        }
      }
      return {
        claimed: events.length,
        published,
        failed,
        eventIds: events.map((event) => event.outboxEventId)
      };
    }
  };
}

function handlerFor(
  handlers: FinancialRuntimeHandlers,
  event: FinancialOutboxEvent
): ((event: FinancialOutboxEvent) => Promise<void>) | undefined {
  if (event.eventType === "ledger.posted" || event.eventType === "account_hierarchy.changed") {
    return handlers.onLedgerChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("invoice.") || event.eventType === "subledger_document.invoice.posted") {
    return handlers.onInvoiceChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("issued_adjustment.") || event.eventType === "subledger_document.credit_memo.posted") {
    return handlers.onAdjustmentChanged ?? handlers.onSubledgerDocumentChanged ?? handlers.onEvent;
  }
  if (event.eventType === "subledger_document.refund.posted") {
    return handlers.onAdjustmentChanged ?? handlers.onPaymentChanged ?? handlers.onSubledgerDocumentChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("vendor_bill.") || event.eventType === "subledger_document.vendor_bill.posted") {
    return handlers.onVendorBillChanged ?? handlers.onSubledgerDocumentChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("payment_match.") || event.eventType.startsWith("subledger_application.") ||
    [
      "subledger_document.customer_payment.posted",
      "subledger_document.customer_payment.voided",
      "subledger_document.bill_payment.posted",
      "subledger_document.deposit.posted",
      "subledger_document.transfer.posted"
    ].includes(event.eventType)) {
    return handlers.onPaymentChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("subledger_document.")) {
    return handlers.onSubledgerDocumentChanged ?? handlers.onEvent;
  }
  if (event.eventType.startsWith("bank_")) return handlers.onBankReconciliationChanged ?? handlers.onEvent;
  return handlers.onEvent;
}

function defaultRetryDelaySeconds(attemptCount: number): number {
  return Math.min(3600, 5 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 10));
}

function safeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 2000);
  return "Unknown financial runtime delivery error";
}
