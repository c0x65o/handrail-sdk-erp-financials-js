import { describe, expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";
import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

const scope = (client: PostgresQueryClient) => createFinancialReadModels({
  database: { transaction: async (work) => work(client) },
  tenantId: "tenant_1",
  companyId: "company_1",
  bookId: "book_1"
});

describe("receivables register read models", () => {
  it("provides bounded, book-scoped invoice and payment-history lookup APIs", async () => {
    const client = new ReceivablesLookupClient();
    const queries = scope(client);

    await expect(queries.latestInvoiceNumberSequence()).resolves.toBe(42);
    await expect(queries.getOpenInvoicesByIds(["invoice_2", "invoice_1", "invoice_2"])).resolves.toEqual([
      {
        invoiceId: "invoice_1",
        documentNumber: "INV-42",
        dueDate: "2026-08-31",
        openAmount: "49.08",
        currencyCode: "USD",
        version: 2
      }
    ]);
    await expect(queries.findCustomerPaymentHistoryPartyIds(["party_2", "party_1", "party_2"])).resolves.toEqual([
      "party_1"
    ]);

    expect(client.openInvoiceParameters).toEqual(["tenant_1", "company_1", "book_1", ["invoice_2", "invoice_1"]]);
    expect(client.historyParameters).toEqual(["tenant_1", "company_1", "book_1", ["party_2", "party_1"]]);
    expect(client.sql.join("\n")).not.toContain("spartan.");
  });

  it("fails closed on invalid or unbounded batch requests", async () => {
    const queries = scope(new ReceivablesLookupClient());
    await expect(queries.getInvoicesByIds(["invoice_1", "invoice_1"])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getInvoicesByIds(Array.from({ length: 101 }, (_, index) => `invoice_${String(index)}`)))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.findCustomerPaymentHistoryPartyIds(Array.from({ length: 1001 }, (_, index) => `party_${String(index)}`)))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("projects canonical customer-payment applications and authoritative open balances", async () => {
    const client = new CustomerPaymentRegisterClient();
    const queries = scope(client);
    const projection = await queries.listCustomerPaymentRegister({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      sort: "amount",
      direction: "desc",
      filter: "automatic",
      limit: 25
    });

    expect(projection).toMatchObject({
      currencyCode: "USD",
      totalCount: 1,
      filteredAmount: "100",
      totals: {
        receivedAmount: "100",
        receivedPaymentCount: 1,
        unappliedAmount: "49.08",
        unappliedPaymentCount: 1,
        automaticallyMatchedPaymentCount: 1,
        matchedPaymentCount: 1
      },
      hasPrevious: false,
      hasNext: false
    });
    expect(projection.items).toEqual([
      expect.objectContaining({
        paymentId: "payment_1",
        amount: "100.00",
        unappliedAmount: "49.08",
        status: "partial",
        matchingMode: "automatic",
        paymentMethod: "ACH",
        sortValue: "100",
        applications: [expect.objectContaining({
          applicationId: "application_1",
          targetDocumentId: "invoice_1",
          targetDocumentNumber: "INV-42",
          amount: "50.92"
        })]
      })
    ]);
    expect(projection.items[0]?.applications[0]?.matchProvenance?.method).toBe("automatic");
    expect(client.pageSql).toContain('application."application_type" = \'customer_payment_to_invoice\'');
    expect(client.totalsSql).toContain('application."currency_code" = $4');
    expect(client.pageSql).not.toContain("spartan.");
  });

  it("ages unapplied receivable offsets by document date so bucket totals reconcile", async () => {
    const client = new AgingClient();
    const report = await scope(client).getAging({ kind: "receivables", asOfDate: "2026-08-31" });

    expect(report.rows[0]).toMatchObject({ current: "0.00", days1To30: "50.92", total: "50.92" });
    expect(client.agingSql).toContain('else document."document_date" end as "aging_date"');
    expect(client.parameters.at(-1)).toEqual(["customer_payment", "credit_memo"]);
  });
});

class ReceivablesLookupClient implements PostgresQueryClient {
  readonly sql: string[] = [];
  openInvoiceParameters?: readonly unknown[];
  historyParameters?: readonly unknown[];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(sql);
    if (sql.includes('from "erp_financials"."reporting_books"')) return rows<Row>([book()]);
    if (sql.includes('max("digits" collate "C")')) return rows<Row>([{ latest_sequence: "42" }]);
    if (sql.includes('with requested as (') && sql.includes('document."open_amount" > 0')) {
      this.openInvoiceParameters = parameters;
      return rows<Row>([{
        invoice_id: "invoice_1", document_number: "INV-42", due_date: "2026-08-31",
        open_amount: "49.08", currency_code: "USD", version: 2
      }]);
    }
    if (sql.includes('select distinct document."party_id"')) {
      this.historyParameters = parameters;
      return rows<Row>([{ party_id: "party_1" }]);
    }
    throw new Error(`Unexpected lookup query: ${sql}`);
  }
}

class CustomerPaymentRegisterClient implements PostgresQueryClient {
  pageSql = "";
  totalsSql = "";

  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) return rows<Row>([book()]);
    if (sql.includes('select payment.*,') && sql.includes('from filtered_rows payment')) {
      this.pageSql = sql;
      return rows<Row>([{
        payment_id: "payment_1", source_id: "source_1", document_type: "customer_payment",
        transaction_id: "transaction_1", party_id: "party_1", party_name: "Acme",
        document_number: "PAY-1", document_date: "2026-08-20", currency_code: "USD",
        original_amount: "100", open_amount: "49.08", returned_amount: "0", version: 1, lifecycle_event_id: "event_1",
        application_count: 1, payment_method: "ACH", applied_to: "INV-42", matching_mode: "automatic",
        match_label: "Automatically matched", payment_status: "partial", sort_key: "100"
      }]);
    }
    if (sql.includes('invoice."document_number" as "target_document_number"')) {
      return rows<Row>([{
        application_id: "application_1", source_id: "source_1", application_type: "customer_payment_to_invoice",
        status: "applied", version: 1, application_date: "2026-08-20", source_payment_id: "payment_1",
        target_document_id: "invoice_1", applied_amount: "50.92", currency_code: "USD",
        applied_event_id: "event_2", ended_event_id: null, match_candidate_id: "candidate_1",
        match_decision_id: "decision_1", match_method: "automatic", match_score: "1",
        match_evidence: {}, target_document_number: "INV-42", target_document_version: 2
      }]);
    }
    if (sql.includes('as "received_amount"')) {
      this.totalsSql = sql;
      return rows<Row>([{
        received_amount: "100", returned_amount: "0", retained_amount: "100", received_count: 1, unapplied_amount: "49.08", unapplied_count: 1,
        automatic_count: 1, matched_count: 1, filtered_amount: "100", filtered_count: 1
      }]);
    }
    throw new Error(`Unexpected payment register query: ${sql}`);
  }
}

class AgingClient implements PostgresQueryClient {
  agingSql = "";
  parameters: readonly unknown[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) return rows<Row>([book()]);
    if (sql.includes("aging_documents as")) {
      this.agingSql = sql;
      this.parameters = parameters;
      return rows<Row>([{
        party_id: "party_1", party_name: "Acme", current_amount: "0", days_1_30: "50.92",
        days_31_60: "0", days_61_90: "0", days_over_90: "0", total_amount: "50.92"
      }]);
    }
    throw new Error(`Unexpected aging query: ${sql}`);
  }
}

function book(): Record<string, unknown> {
  return { base_currency_code: "USD", accounting_basis: "accrual", status: "active" };
}

function rows<Row extends Record<string, unknown>>(values: readonly Record<string, unknown>[]): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: values as Row[] });
}
