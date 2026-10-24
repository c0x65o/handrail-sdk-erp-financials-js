import { describe, expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";
import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

const statement = (client: PostgresQueryClient) => createFinancialReadModels({
  database: { transaction: async (work) => work(client) },
  tenantId: "tenant_1",
  companyId: "company_1",
  bookId: "book_1"
});

describe("customer statement read model", () => {
  it("returns deterministic pages with full-statement and page-reconciling totals", async () => {
    const client = new CustomerStatementClient();
    const queries = statement(client);

    const first = await queries.getCustomerStatement({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      limit: 1
    });

    expect(first).toMatchObject({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      currencyCode: "USD",
      totals: {
        settlement: { cashAppliedAmount: "90.00", creditAppliedAmount: "0.00", writeOffAppliedAmount: "0.00" },
        invoiceCount: 2,
        invoicedAmount: "150.00",
        appliedAmount: "90.00",
        outstandingAmount: "60.00"
      },
      pageTotals: {
        invoiceCount: 1,
        invoicedAmount: "100.00",
        appliedAmount: "40.00",
        outstandingAmount: "60.00"
      }
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === undefined) throw new Error("Expected a customer statement cursor");
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      invoiceId: "invoice_1",
      documentNumber: "INV-1",
      originalAmount: "100.00",
      appliedAmount: "40.00",
      openBalance: "60.00",
      sourceIdentity: {
        sourceId: "source_1",
        sourceSystem: "native_erp",
        transactionId: "transaction_invoice_1",
        sourceTransactionId: "source_invoice_1"
      },
      applications: [{
        applicationId: "application_1",
        status: "applied",
        applicationDate: "2026-08-15",
        amount: "40.00",
        endedLifecycleEventId: "event_unapplied_later",
        sourceDocumentId: "payment_1",
        sourceDocumentNumber: "PAY-1"
      }]
    });

    const second = await queries.getCustomerStatement({
      customerId: "customer_1",
      asOfDate: "2026-08-31",
      limit: 1,
      cursor: first.nextCursor
    });
    expect(second.items.map((item) => item.invoiceId)).toEqual(["invoice_2"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.pageTotals).toEqual({
      settlement: { cashAppliedAmount: "50.00", creditAppliedAmount: "0.00", writeOffAppliedAmount: "0.00" },
      invoiceCount: 1,
      invoicedAmount: "50.00",
      appliedAmount: "50.00",
      outstandingAmount: "0.00"
    });

    expect(client.statementSql).toContain('document."tenant_id" = $1 and document."company_id" = $2');
    expect(client.statementSql).toContain('book_source."book_id" = $3');
    expect(client.statementSql).toContain('document."party_id" = $4');
    expect(client.statementSql).toContain('document."document_date" <= $6::date');
    expect(client.statementSql).toContain(`coalesce((ended_event."payload"->>'effectiveDate')::date, (ended_event."occurred_at" at time zone 'UTC')::date) >= ($6::date + interval '1 day')`);
    expect(client.statementSql).not.toContain('document."open_amount"');
    expect(client.statementParameters[0]).toEqual([
      "tenant_1", "company_1", "book_1", "customer_1", "USD", "2026-08-31", undefined, undefined, 2, true
    ]);
    expect(client.statementParameters[1]?.slice(0, 6)).toEqual([
      "tenant_1", "company_1", "book_1", "customer_1", "USD", "2026-08-31"
    ]);
  });

  it("rejects inconsistent settlement classification and any overapplied invoice before returning a page", async () => {
    for (const mode of ["classification", "overapplied"] as const) {
      const queries = statement(new CustomerStatementClient(row => mode === "classification" ? { ...row, cash_applied_amount: "0" } : { ...row, invalid_balance: true }));
      await expect(queries.getCustomerStatement({ customerId: "customer_1", asOfDate: "2026-08-31", limit: 1 })).rejects.toMatchObject({ code: "reconciliation_conflict" });
    }
  });

  it("rejects invalid required fields, limits, and cross-request cursors", async () => {
    const queries = statement(new CustomerStatementClient());
    await expect(queries.getCustomerStatement({ customerId: " ", asOfDate: "2026-08-31" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getCustomerStatement({ customerId: "customer_1", asOfDate: "2026-02-30" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getCustomerStatement({ customerId: "customer_1", asOfDate: "2026-08-31", limit: 201 }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const first = await queries.getCustomerStatement({ customerId: "customer_1", asOfDate: "2026-08-31", limit: 1 });
    if (first.nextCursor === undefined) throw new Error("Expected a customer statement cursor");
    await expect(queries.getCustomerStatement({ customerId: "customer_1", asOfDate: "2026-08-31", includeApplications: false, cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getCustomerStatement({
      customerId: "customer_2",
      asOfDate: "2026-08-31",
      limit: 1,
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

class CustomerStatementClient implements PostgresQueryClient {
  constructor(private readonly transform: (row: Record<string, unknown>) => Record<string, unknown> = row => row) {}
  statementSql = "";
  readonly statementParameters: (readonly unknown[])[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return rows<Row>([{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" }]);
    }
    if (sql.includes("with scoped_invoices as")) {
      this.statementSql = sql;
      this.statementParameters.push(parameters);
      return rows<Row>((parameters[6] === undefined ? [invoiceOne(), invoiceTwo()] : [invoiceTwo()]).map(this.transform));
    }
    throw new Error(`Unexpected customer statement query: ${sql}`);
  }
}

function invoiceOne(): Record<string, unknown> {
  return {
    revision: "a".repeat(64), current_book: {currency:"USD",basis:"accrual",status:"active"},
    invoice_id: "invoice_1", source_id: "source_1", transaction_id: "transaction_invoice_1",
    customer_id: "customer_1", customer_name: "Acme", document_number: "INV-1",
    document_date: "2026-08-01", due_date: "2026-08-31", currency_code: "USD",
    original_amount: "100", applied_amount: "40", open_balance: "60",
    cash_applied_amount: "40", credit_applied_amount: "0", write_off_applied_amount: "0",
    total_cash_applied_amount: "90", total_credit_applied_amount: "0", total_write_off_applied_amount: "0", invalid_balance: false,
    source_system: "native_erp", provider_environment: "test",
    source_transaction_id: "source_invoice_1", source_transaction_type: "Invoice",
    applications: [{
      applicationId: "application_1", applicationType: "customer_payment_to_invoice",
      applicationDate: "2026-08-15", amount: "40", currencyCode: "USD",
      sourceDocumentId: "payment_1", sourceDocumentType: "customer_payment", sourceDocumentNumber: "PAY-1",
      sourceDocumentDate: "2026-08-15", sourceId: "source_1", sourceSystem: "native_erp",
      providerEnvironment: "test", transactionId: "transaction_payment_1",
      sourceTransactionId: "source_payment_1", sourceTransactionType: "Payment",
      appliedLifecycleEventId: "event_applied", endedLifecycleEventId: "event_unapplied_later"
    }],
    total_invoice_count: 2, total_invoiced_amount: "150", total_applied_amount: "90",
    total_outstanding_amount: "60"
  };
}

function invoiceTwo(): Record<string, unknown> {
  return {
    ...invoiceOne(),
    invoice_id: "invoice_2", transaction_id: "transaction_invoice_2", document_number: "INV-2",
    document_date: "2026-08-20", original_amount: "50", applied_amount: "50", open_balance: "0", cash_applied_amount: "50",
    source_transaction_id: "source_invoice_2",
    applications: [{
      ...(invoiceOne().applications as Record<string, unknown>[])[0],
      applicationId: "application_2", amount: "50", endedLifecycleEventId: null
    }]
  };
}

function rows<Row extends Record<string, unknown>>(
  values: readonly Record<string, unknown>[]
): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: values as Row[] });
}
