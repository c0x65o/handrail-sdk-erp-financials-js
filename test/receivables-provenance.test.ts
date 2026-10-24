import { describe, expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";

import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

describe("canonical receivables provenance reads", () => {
  it("returns immutable invoice unit cost and append-only delivery history", async () => {
    const queries = readModels();

    await expect(queries.getInvoice("invoice_1", "2026-08-15")).resolves.toMatchObject({
      invoiceId: "invoice_1",
      transactionId: "transaction_invoice_1", idempotencyKey: "invoice:create",
      createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z",
      creationLifecycle: { lifecycleEventId: "creation_1", actorRef: "user:billing", requestId: "create:1", reasonCode: "invoice_create" },
      lines: [{ unitAmount: "100.00", unitCost: "62.125000", amount: "100.00" }]
    });
    await expect(queries.listInvoiceDeliveries("invoice_1", { limit: 10 })).resolves.toEqual({
      items: [{
        deliveryEventId: "delivery_1",
        invoiceId: "invoice_1",
        status: "delivered",
        channel: "email",
        recipientRef: "billing:acme",
        occurredAt: "2026-08-15T12:00:00.000Z",
        lifecycleEventId: "lifecycle_delivery_1"
      }]
    });
  });

  it("does not classify unknown balance reductions as cash payments",async()=>{
    const invoice=await readModels({open_amount:"87.66"}).getInvoice("invoice_1");
    expect(invoice.settlement).toEqual({basis:"current",cashAppliedAmount:"0.00",creditAppliedAmount:"0.00",writeOffAppliedAmount:"0.00",cancellationAmount:"0.00",unclassifiedAmount:"12.34",balanceReductionAmount:"12.34"});
  });

  it("reloads customer-payment and application provenance through company-scoped reads", async () => {
    const queries = readModels();

    await expect(queries.getCustomerPayment("payment_1")).resolves.toMatchObject({
      paymentId: "payment_1",
      createdAt: "2026-08-14T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z", idempotencyKey: "receipt:create",
      creationLifecycle: { actorRef: "user:cashier", lifecycleEventId: "lifecycle_payment_1", requestId: "receipt:1", reasonCode: "receipt_create" },
      transactionId: "transaction_payment_1",
      version: 2,
      lifecycleEventId: "lifecycle_payment_1",
      provenance: {
        externalBankMatch: {
          externalMatchId: "external-match-1",
          bankStatementLineId: "bank-line-1",
          matchedAt: "2026-08-14T10:00:00.000Z"
        },
        deposit: { depositId: "deposit-1", depositedAt: "2026-08-15T10:00:00.000Z" }
      },
      applications: [{
        applicationId: "application_1",
        applicationType: "customer_payment_to_invoice",
        sourcePaymentId: "payment_1",
        targetDocumentId: "invoice_1",
        amount: "40.00",
        matchProvenance: {
          matchCandidateId: "candidate_1",
          matchDecisionId: "decision_1",
          method: "automatic",
          score: "0.98",
          evidence: { rule: "amount_and_reference" }
        }
      }]
    });
    await expect(queries.getPaymentApplication("application_1")).resolves.toMatchObject({
      applicationId: "application_1",
      status: "applied",
      version: 1,
      appliedLifecycleEventId: "lifecycle_application_1"
    });
  });

  it("returns write-off account/approval/correction links and refund provenance", async () => {
    const queries = readModels();

    await expect(queries.getWriteOff("write_off_1")).resolves.toMatchObject({
      writeOffId: "write_off_1",
      customerId: "customer_1",
      relatedInvoiceId: "invoice_1",
      reason: "Uncollectible after final notice",
      balanceType: "receivable",
      balanceAccountId: "receivable",
      writeOffAccountId: "bad_debt",
      reversalTransactionId: "transaction_write_off_reversal_1",
      replacementWriteOffId: "write_off_2",
      status: "replaced",
      lifecycle: {
        lifecycleEventId: "lifecycle_write_off_1",
        actorRef: "user:collector",
        approverRef: "user:controller"
      }
    });
    await expect(queries.getAdjustment("refund_1")).resolves.toMatchObject({
      adjustmentId: "refund_1",
      adjustmentType: "refund",
      refundProvenance: {
        relatedInvoiceId: "invoice_1",
        refundMethod: "ach",
        lifecycleReference: "refund-case-1"
      },
      lifecycle: {
        lifecycleEventId: "lifecycle_refund_1",
        actorRef: "user:billing",
        approverRef: "user:controller"
      }
    });
  });
});

function readModels(invoiceChanges: Record<string, unknown> = {}) {
  const client = new ReceivablesClient(invoiceChanges);
  return createFinancialReadModels({
    database: { transaction: async <Result>(work: (queryClient: PostgresQueryClient) => Promise<Result>) => work(client) },
    tenantId: "tenant_1",
    companyId: "company_1",
    bookId: "book_1"
  });
}

class ReceivablesClient implements PostgresQueryClient {
  constructor(private readonly invoiceChanges: Record<string, unknown> = {}) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    const result = (values: readonly Record<string, unknown>[]): Promise<PostgresQueryResult<Row>> =>
      Promise.resolve({ rows: values as readonly Row[] });
    if (sql.includes('from "erp_financials"."reporting_books"')) return result([{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" }]);
    if (sql.includes("invoice_detail_rows as")) return result([{ current_book: {currency:"USD",basis:"accrual",status:"active"}, ...invoiceRow(), ...this.invoiceChanges, memo: "August services", ...commercialLine() }]);
    if (sql.includes('select transaction."memo"') && sql.includes('document join "erp_financials"."transactions"')) return result([{ memo: "August services" }]);
    if (sql.includes('select "subledger_document_line_id" as "line_id"') && sql.includes('subledger_document_id" = $4')) return result([commercialLine()]);
    if (sql.includes('from "erp_financials"."subledger_document_delivery_events" event')) return result([{
      delivery_event_id: "delivery_1", invoice_id: "invoice_1", delivery_status: "delivered", channel: "email",
      recipient_ref: "billing:acme", occurred_at: "2026-08-15T12:00:00.000Z", lifecycle_event_id: "lifecycle_delivery_1"
    }]);
    if (sql.includes('document."metadata"') && sql.includes('transaction."memo"') && sql.includes("document.\"document_type\" = 'customer_payment'")) return result([{
      created_at: "2026-08-14T10:00:00.000Z", updated_at: "2026-08-15T10:00:00.000Z", idempotency_key: "receipt:create",
      actor_ref: "user:cashier", request_id: "receipt:1", reason_code: "receipt_create",
      application_rows: [applicationRow()], payment_id: "payment_1", source_id: "source_1", document_type: "customer_payment",
      transaction_id: "transaction_payment_1", party_id: "customer_1", party_name: "Acme", document_number: "PAY-1",
      document_date: "2026-08-14", currency_code: "USD", original_amount: "50", open_amount: "10", returned_amount: "0", document_status: "partially_applied",
      version: 2, lifecycle_event_id: "lifecycle_payment_1", memo: "ACH receipt", application_count: 1,
      metadata: { customerPaymentProvenance: {
        externalBankMatch: { externalMatchId: "external-match-1", bankStatementLineId: "bank-line-1", matchedAt: "2026-08-14T10:00:00.000Z" },
        deposit: { depositId: "deposit-1", depositedAt: "2026-08-15T10:00:00.000Z" }
      } }
    }]);
    if (sql.includes('application."subledger_application_id" as "application_id", application."source_id"')) return result([applicationRow()]);
    if (sql.includes("with write_off_rows as")) return result([writeOffRow()]);
    if (sql.includes('document."subledger_document_id" = $4') && sql.includes("document.\"document_type\" = 'write_off'")) return result([{
      memo: "Approved bad debt", metadata: writeOffRow().metadata, lifecycle_event_id: "lifecycle_write_off_1",
      actor_ref: "user:collector", approver_ref: "user:controller", request_id: "request-write-off-1", reason_code: "bad_debt"
    }]);
    if (sql.includes("with adjustment_rows as")) return result([{
      adjustment_id: "refund_1", source_id: "source_1", transaction_id: "transaction_refund_1", adjustment_type: "refund",
      party_id: "customer_1", party_name: "Acme", document_number: "REF-1", document_date: "2026-08-15",
      currency_code: "USD", original_amount: "10", open_amount: "0", status: "settled", version: 1,
      reversal_transaction_id: null, replacement_adjustment_id: null, replaces_adjustment_id: null
    }]);
    if (sql.includes('select transaction."memo", document."metadata"')) return result([{
      memo: "ACH refund", metadata: { refundProvenance: { relatedInvoiceId: "invoice_1", refundMethod: "ach", lifecycleReference: "refund-case-1" } },
      lifecycle_event_id: "lifecycle_refund_1", actor_ref: "user:billing", approver_ref: "user:controller",
      request_id: "request-refund-1", reason_code: "customer_refund"
    }]);
    if (sql.includes('from "erp_financials"."subledger_document_lines"')) return result([]);
    if (sql.includes('from "erp_financials"."ledger_postings" posting')) return result([]);
    if (sql.includes('from "erp_financials"."subledger_applications" application')) return result([]);
    throw new Error(`Unexpected receivables query: ${sql}`);
  }
}

function invoiceRow() {
  return {
    invoice_id: "invoice_1", source_id: "source_1", provenance: "posted", party_id: "customer_1", party_name: "Acme",
    document_number: "INV-1", document_date: "2026-08-01", due_date: "2026-08-31", currency_code: "USD",
    cash_applied_amount:"0",credit_applied_amount:"0",write_off_applied_amount:"0",cancellation_amount:"0",
    original_amount: "100", open_amount: "100", status: "open", version: 1,
    created_at: "2026-08-01T12:00:00.000Z", updated_at: "2026-08-01T12:00:00.000Z", idempotency_key: "invoice:create",
    transaction_id: "transaction_invoice_1", lifecycle_event_id: "creation_1", actor_ref: "user:billing", request_id: "create:1", reason_code: "invoice_create"
  };
}

function commercialLine() {
  return {
    line_id: "line_1", line_number: 1, account_id: "revenue", item_id: "service", description: "Service",
    quantity: "1", unit_amount: "100", unit_cost: "62.125000", discount_amount: "0", tax_code: null,
    tax_amount: "0", service_period_start: null, service_period_end: null, dimension_refs: [], line_amount: "100"
  };
}

function applicationRow() {
  return {
    application_id: "application_1", source_id: "source_1", application_type: "customer_payment_to_invoice",
    status: "applied", version: 1, application_date: "2026-08-14", source_payment_id: "payment_1",
    target_document_id: "invoice_1", applied_amount: "40", currency_code: "USD",
    applied_event_id: "lifecycle_application_1", ended_event_id: null, match_candidate_id: "candidate_1",
    match_decision_id: "decision_1", match_method: "automatic", match_score: "0.98",
    match_evidence: { rule: "amount_and_reference" }
  };
}

function writeOffRow() {
  return {
    write_off_id: "write_off_1", source_id: "source_1", transaction_id: "transaction_write_off_1",
    party_id: "customer_1", party_name: "Acme", document_number: "WO-1", document_date: "2026-08-15",
    currency_code: "USD", original_amount: "25", version: 2, status: "replaced",
    reversal_transaction_id: "transaction_write_off_reversal_1", replacement_write_off_id: "write_off_2",
    replaces_write_off_id: null, metadata: { writeOffProvenance: {
      balanceType: "receivable", balanceAccountId: "receivable", writeOffAccountId: "bad_debt",
      relatedInvoiceId: "invoice_1", reason: "Uncollectible after final notice"
    } }
  };
}
