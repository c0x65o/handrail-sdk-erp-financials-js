import { describe, expect, it } from "vitest";

import {
  ErpFinancialsError,
  createErpFinancials,
  createFinancialReadModels,
  createFinancialRuntime,
  normalizeCommercialDocumentLine
} from "../src/index.js";

import type {
  FinancialOutboxEvent,
  FinancialOutboxService,
  PostgresQueryClient,
  PostgresQueryResult
} from "../src/index.js";

describe("pre-v1 SDK foundation", () => {
  it("lists provider-neutral parties from every source bound to the reporting book", async () => {
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(new PartyClient()) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    await expect(queries.listParties({ partyType: "vendor", limit: 25 })).resolves.toEqual({
      items: [{
        partyId: "party_vendor_1",
        sourceId: "quickbooks_1",
        sourcePartyId: "42",
        partyType: "vendor",
        displayName: "Secure Supply Co",
        active: true
      }]
    });
  });

  it("lists every imported operational document family through one canonical register", async () => {
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(new OperationalDocumentClient()) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    await expect(queries.listOperationalDocuments({
      documentTypes: ["sales_receipt", "purchase", "deposit", "transfer"],
      sourceId: "quickbooks_1",
      periodStart: "2026-01-01",
      periodEnd: "2026-08-31",
      limit: 25
    })).resolves.toEqual({
      items: [expect.objectContaining({
        documentId: "qbo_sales_receipt_1",
        sourceId: "quickbooks_1",
        sourceSystem: "quickbooks",
        providerEnvironment: "production",
        documentType: "sales_receipt",
        sourceTransactionId: "9001",
        sourceTransactionType: "SalesReceipt",
        partyName: "Acme",
        documentNumber: "SR-9001",
        originalAmount: "125.00",
        openAmount: "0.00",
        status: "settled"
      })]
    });
  });

  it("normalizes commercial lines with exact quantity, discount, and tax arithmetic", () => {
    expect(normalizeCommercialDocumentLine({
      amount: "24.50",
      quantity: "2.5",
      unitAmount: "10.00",
      unitCost: "6.125000",
      discountAmount: "2.00",
      taxAmount: "1.50",
      itemId: "item_1"
    })).toMatchObject({
      amount: "24.50",
      quantity: "2.5",
      unitAmount: "10.00",
      unitCost: "6.125000",
      discountAmount: "2.00",
      taxAmount: "1.50"
    });

    expect(() => normalizeCommercialDocumentLine({
      amount: "10.00",
      unitCost: "1.1234567"
    })).toThrow("at most six fractional digits");

    const invalidLine = () => normalizeCommercialDocumentLine({
      amount: "24.49",
      quantity: "2.5",
      unitAmount: "10.00",
      discountAmount: "2.00",
      taxAmount: "1.50"
    });
    expect(invalidLine).toThrow("amount must equal");
    try {
      invalidLine();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });

  it.each([
    ["723", "1.7472", "1263.23"], ["600", "10.4832", "6289.92"],
    ["3", "12.50", "37.50"], ["2.5", "10.25", "25.63"],
    ["1.0001", "1.0049", "1.01"],
  ])("extends the full unit rate %s × %s to %s", (quantity, unitAmount, amount) => {
    expect(normalizeCommercialDocumentLine({ quantity, unitAmount, amount })).toMatchObject({ quantity, unitAmount, amount });
  });

  it("rejects overprecision and incorrect extensions without rounding the rate", () => {
    expect(() => normalizeCommercialDocumentLine({ quantity: "723", unitAmount: "1.7472", amount: "1263.23" }, "draft", 2)).toThrow("at most two fractional digits");
    expect(() => normalizeCommercialDocumentLine({ quantity: "723", unitAmount: "1.74721", amount: "1263.23" })).toThrow("at most four fractional digits");
    expect(() => normalizeCommercialDocumentLine({ quantity: "723", unitAmount: "1.7472", amount: "1263.22" })).toThrow("amount must equal");
    expect(() => normalizeCommercialDocumentLine({ quantity: "723", unitAmount: "1.7472", amount: "1263.2256" })).toThrow("at most two fractional digits");
  });

  it("fails closed on cross-currency subledger commands before opening a transaction", async () => {
    let transactions = 0;
    const service = createErpFinancials({
      database: {
        transaction<Result>(): Promise<Result> {
          transactions += 1;
          return Promise.reject(new Error("transaction should not start"));
        }
      },
      tenantId: "tenant_1",
      companyId: "company_1",
      sourceId: "source_1",
      currencyCode: "USD",
      currencyPolicy: "single_currency"
    });

    await expect(service.invoices.create({
      operation: operation(),
      idempotencyKey: "invoice-cad",
      date: "2026-08-12",
      dueDate: "2026-09-12",
      customerId: "customer_1",
      currencyCode: "CAD",
      receivableAccount: { accountId: "ar" },
      revenueLines: [{ accountId: "income", amount: "10.00" }]
    })).rejects.toMatchObject({ code: "currency_not_supported" } satisfies Partial<ErpFinancialsError>);
    expect(transactions).toBe(0);
  });

  it("rolls book-owned account hierarchies into statement rows and totals", async () => {
    const client = new StatementClient();
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    const report = await queries.getFinancialStatement({
      reportName: "profit_and_loss",
      periodStart: "2026-01-01",
      periodEnd: "2026-08-12",
      accountingMethod: "cash"
    });

    expect(report.lines).toEqual([
      expect.objectContaining({ bookAccountKey: "income", directAmount: "0.00", amount: "150.00" }),
      expect.objectContaining({ bookAccountKey: "services", directAmount: "150.00", amount: "150.00" }),
      expect.objectContaining({ bookAccountKey: "expenses", amount: "20.00" })
    ]);
    expect(report.totals).toMatchObject({ income: "150.00", expenses: "20.00", netIncome: "130.00" });
    expect(report.accountingBasis).toBe("cash");
    expect(client.statementAccountingBasis).toBe("cash");
    expect(report.lines[1]?.drilldown).toEqual({
      periodStart: "2026-01-01",
      periodEnd: "2026-08-12",
      accountingMethod: "cash",
      accountKey: "services"
    });
  });

  it("rolls historical and current earnings into balance-sheet equity", async () => {
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(new BalanceSheetStatementClient()) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    const report = await queries.getFinancialStatement({
      reportName: "balance_sheet",
      periodStart: "2026-01-01",
      periodEnd: "2026-08-12",
      asOfDate: "2026-08-12"
    });

    expect(report.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Retained Earnings", classification: "equity", amount: "500.00" }),
      expect.objectContaining({ name: "Net Income", classification: "equity", amount: "130.00" })
    ]));
    expect(report.totals).toEqual({
      assets: "680.00",
      liabilities: "50.00",
      equity: "630.00",
      difference: "0.00"
    });
    expect(report.accountingBasis).toBe("accrual");
    expect(report.lines[0]?.drilldown).toMatchObject({
      periodStart: "0001-01-01",
      periodEnd: "2026-08-12",
      accountingMethod: "accrual"
    });
    expect(report.lines.find((line) => line.name === "Retained Earnings")?.drilldown).toBeUndefined();
    expect(report.lines.find((line) => line.name === "Net Income")?.drilldown).toBeUndefined();
  });

  it("defaults dashboard reporting to the book basis and accepts a cash override", async () => {
    const client = new DashboardClient();
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    const defaultSummary = await queries.getDashboardSummary({
      periodStart: "2026-01-01",
      asOfDate: "2026-08-12"
    });
    const cashSummary = await queries.getDashboardSummary({
      periodStart: "2026-01-01",
      asOfDate: "2026-08-12",
      accountingMethod: "cash"
    });

    expect(defaultSummary).toMatchObject({ accountingBasis: "accrual", netIncome: "130.00" });
    expect(cashSummary).toMatchObject({ accountingBasis: "cash", netIncome: "130.00" });
    expect(client.requestedAccountingBases).toEqual(["accrual", "cash"]);
  });

  it("exposes canonical credit/refund register and adjustment detail models", async () => {
    const client = new AdjustmentClient();
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    await expect(queries.listAdjustments({ adjustmentType: "credit", status: "replaced" })).resolves.toEqual({
      items: [expect.objectContaining({
        adjustmentId: "credit_1",
        adjustmentType: "credit",
        status: "replaced",
        reversalTransactionId: "reversal_1",
        replacementAdjustmentId: "credit_2"
      })]
    });
    await expect(queries.getAdjustment("credit_1")).resolves.toMatchObject({
      adjustmentId: "credit_1",
      memo: "Customer service adjustment",
      lines: [expect.objectContaining({ lineId: "credit_line_1", amount: "25.00" })],
      postings: [
        expect.objectContaining({ accountId: "revenue", debitAmount: "25.00", creditAmount: "0.00" }),
        expect.objectContaining({ accountId: "receivable", debitAmount: "0.00", creditAmount: "25.00" })
      ],
      applications: [expect.objectContaining({ applicationId: "application_1", amount: "5.00" })]
    });
  });

  it("exposes company-scoped vendor bill registers, KPI summary, immutable detail, and applications", async () => {
    const client = new VendorBillClient();
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    await expect(queries.listVendorBills({
      asOfDate: "2026-08-14",
      status: "partial",
      vendorId: "vendor_1",
      limit: 25
    })).resolves.toEqual({
      items: [expect.objectContaining({
        billId: "bill_1",
        sourceId: "source_1",
        sourceProvenance: "posted",
        transactionId: "transaction_bill_1",
        vendorId: "vendor_1",
        originalAmount: "125.00",
        openAmount: "75.00",
        status: "partial",
        version: 2
      })]
    });

    await expect(queries.getVendorBill("bill_1", "2026-08-14")).resolves.toMatchObject({
      billId: "bill_1",
      memo: "Annual security subscription",
      lines: [expect.objectContaining({
        lineId: "bill_line_1",
        accountId: "expense_security",
        sourceAccountKey: "security-expense",
        sourceAccountName: "Security expense",
        bookAccountKey: "software-security",
        accountMappingProvenance: "reporting_book_mapping",
        accountMappingId: "mapping_1",
        itemId: "item_security",
        sourceItemId: "source-item-security",
        customerId: "customer_1",
        customerName: "Houchens Industries, Inc.",
        categoryMappingProvenance: "item_expense_account",
        quantity: "1",
        unitAmount: "1.7472",
        amount: "125.00"
      })],
      applications: [expect.objectContaining({
        applicationId: "application_1",
        sourcePaymentId: "payment_1",
        applicationDate: "2026-08-10",
        amount: "50.00",
        status: "applied",
        version: 1
      })]
    });

    await expect(queries.getVendorBillSummary({
      asOfDate: "2026-08-14",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-14",
      vendorId: "vendor_1"
    })).resolves.toEqual({
      asOfDate: "2026-08-14",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-14",
      currencyCode: "USD",
      outstandingAmount: "75.00",
      outstandingVendorBillCount: 1,
      overdueAmount: "75.00",
      overdueVendorBillCount: 1,
      paidAmount: "50.00",
      paidInPeriodAmount: "50.00",
      paidInPeriodVendorBillCount: 1,
      settledVendorBillCount: 0,
      voidedVendorBillCount: 0,
      replacedVendorBillCount: 0
    });

    await expect(queries.getVendorBillSummary({
      asOfDate: "2026-08-14",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-15"
    })).rejects.toMatchObject({ code: "invalid_input" });

    expect(client.billListParams).toEqual(expect.arrayContaining([
      "tenant_1",
      "company_1",
      "book_1",
      "2026-08-14",
      "vendor_1",
      "partial"
    ]));
    expect(client.billListSql).toContain('document."metadata" ->> \'provider\' = \'quickbooks\'');
    expect(client.billListSql).toContain('then document."open_amount"');
    expect(client.billListSql).toContain("('bill_payment_to_bill', 'vendor_credit_to_bill')");
    expect(client.billSummarySql).toContain('document."metadata" ->> \'provider\' = \'quickbooks\'');
    expect(client.billSummarySql).toContain('then document."open_amount"');
  });

  it("exposes guarded bill-payment list filters and versioned lifecycle detail", async () => {
    const client = new BillPaymentClient();
    const queries = createFinancialReadModels({
      database: { transaction: async (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    await expect(queries.listPayments({
      paymentType: "bill_payment",
      vendorId: "vendor_1",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-14",
      status: "voided",
      limit: 25
    })).resolves.toEqual({
      items: [expect.objectContaining({
        paymentId: "payment_1",
        paymentType: "bill_payment",
        transactionId: "transaction_payment_1",
        partyId: "vendor_1",
        paymentDate: "2026-08-05",
        amount: "20.00",
        unappliedAmount: "0.00",
        status: "voided",
        version: 2,
        lifecycleEventId: "event_payment_posted"
      })]
    });
    expect(client.paymentListParams).toEqual(expect.arrayContaining([
      "bill_payment",
      "vendor_1",
      "2026-08-01",
      "2026-08-14",
      "voided"
    ]));

    await expect(queries.getBillPayment("payment_1")).resolves.toMatchObject({
      paymentId: "payment_1",
      vendorId: "vendor_1",
      vendorName: "Northwind Security",
      transactionId: "transaction_payment_1",
      status: "voided",
      version: 2,
      paymentMethod: "ach",
      reference: "ACH-100",
      fundingAccount: { accountId: "account_cash", postingId: "posting_cash" },
      payableAccount: { accountId: "account_ap", postingId: "posting_ap" },
      memo: "Duplicate payment",
      lifecycle: {
        posted: {
          lifecycleEventId: "event_payment_posted",
          actorRef: "user:clerk",
          requestId: "request-post-payment"
        },
        voided: {
          lifecycleEventId: "event_payment_voided",
          actorRef: "user:controller",
          approverRef: "user:cfo",
          requestId: "request-void-payment"
        },
        reversalTransactionId: "transaction_payment_reversal"
      },
      applications: [expect.objectContaining({
        applicationId: "application_1",
        sourcePaymentId: "payment_1",
        targetDocumentId: "bill_1",
        status: "unapplied",
        version: 2
      })]
    });

    await expect(queries.getBillPaymentSummary({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31"
    })).resolves.toEqual({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      currencyCode: "USD",
      scheduledAmount: "30.00",
      scheduledCount: 1,
      clearedAmount: "20.00",
      clearedCount: 1,
      voidedAmount: "10.00",
      voidedCount: 1,
      totalAmount: "60.00",
      totalCount: 3
    });

    await expect(queries.listPayments({
      periodStart: "2026-08-15",
      periodEnd: "2026-08-14"
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("delivers outbox work through bounded runtime routing and publishes only successful events", async () => {
    const event = outboxEvent();
    const published: string[] = [];
    const failed: string[] = [];
    const outbox: FinancialOutboxService = {
      claim: () => Promise.resolve([event]),
      markPublished: (id) => { published.push(id); return Promise.resolve(); },
      markFailed: ({ outboxEventId }) => { failed.push(outboxEventId); return Promise.resolve(); }
    };
    const runtime = createFinancialRuntime({
      outbox,
      handlers: { onLedgerChanged: () => Promise.resolve() },
      now: () => "2026-08-12T12:00:00.000Z"
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      claimed: 1,
      published: 1,
      failed: 0,
      eventIds: [event.outboxEventId]
    });
    expect(published).toEqual([event.outboxEventId]);
    expect(failed).toEqual([]);
  });

  it("routes issued-adjustment lifecycle events to the adjustment handler", async () => {
    const event = { ...outboxEvent(), eventType: "issued_adjustment.replaced" };
    const handled: string[] = [];
    const outbox: FinancialOutboxService = {
      claim: () => Promise.resolve([event]),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve()
    };
    const runtime = createFinancialRuntime({
      outbox,
      handlers: { onAdjustmentChanged: (candidate) => { handled.push(candidate.eventType); return Promise.resolve(); } }
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ published: 1, failed: 0 });
    expect(handled).toEqual(["issued_adjustment.replaced"]);
  });

  it("routes vendor-bill posting and correction events to the vendor-bill handler", async () => {
    const events = [
      { ...outboxEvent(), eventType: "subledger_document.vendor_bill.posted" },
      { ...outboxEvent(), outboxEventId: "outbox_vendor_bill_void", eventType: "vendor_bill.voided" }
    ];
    const handled: string[] = [];
    const outbox: FinancialOutboxService = {
      claim: () => Promise.resolve(events),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve()
    };
    const runtime = createFinancialRuntime({
      outbox,
      handlers: {
        onVendorBillChanged: (event) => {
          handled.push(event.eventType);
          return Promise.resolve();
        }
      }
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ published: 2, failed: 0 });
    expect(handled).toEqual(["subledger_document.vendor_bill.posted", "vendor_bill.voided"]);
  });
});

class StatementClient implements PostgresQueryClient {
  statementAccountingBasis: unknown;

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes('from "erp_financials"."accounts"')) {
      this.statementAccountingBasis = params[3];
      return Promise.resolve({ rows: [
        {
          book_account_key: "services",
          parent_book_account_key: "income",
          account_number: "4010",
          account_name: "Services",
          classification: "income",
          debit_amount: "0",
          credit_amount: "150",
          net_amount: "-150"
        },
        {
          book_account_key: "expenses",
          parent_book_account_key: null,
          account_number: "6000",
          account_name: "Expenses",
          classification: "expense",
          debit_amount: "20",
          credit_amount: "0",
          net_amount: "20"
        }
      ] as unknown as Row[] });
    }
    if (sql.includes('from "erp_financials"."reporting_book_accounts"')) {
      return Promise.resolve({ rows: [
        {
          book_account_key: "income",
          parent_book_account_key: null,
          account_number: "4000",
          account_name: "Income",
          classification: "income"
        },
        {
          book_account_key: "services",
          parent_book_account_key: "income",
          account_number: "4010",
          account_name: "Services",
          classification: "income"
        },
        {
          book_account_key: "expenses",
          parent_book_account_key: null,
          account_number: "6000",
          account_name: "Expenses",
          classification: "expense"
        }
      ] as unknown as Row[] });
    }
    throw new Error(`Unexpected statement query: ${sql}`);
  }
}

class BalanceSheetStatementClient implements PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes('as "retained_earnings"')) {
      return Promise.resolve({
        rows: [{ retained_earnings: "500", net_income: "130" } as unknown as Row]
      });
    }
    if (sql.includes('from "erp_financials"."accounts"')) {
      return Promise.resolve({ rows: [
        {
          book_account_key: "cash",
          parent_book_account_key: null,
          account_number: "1000",
          account_name: "Cash",
          classification: "asset",
          debit_amount: "680",
          credit_amount: "0",
          net_amount: "680"
        },
        {
          book_account_key: "payables",
          parent_book_account_key: null,
          account_number: "2000",
          account_name: "Payables",
          classification: "liability",
          debit_amount: "0",
          credit_amount: "50",
          net_amount: "-50"
        }
      ] as unknown as Row[] });
    }
    if (sql.includes('from "erp_financials"."reporting_book_accounts"')) {
      return Promise.resolve({ rows: [] });
    }
    throw new Error(`Unexpected balance-sheet statement query: ${sql}`);
  }
}

class DashboardClient implements PostgresQueryClient {
  readonly requestedAccountingBases: unknown[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes("with scoped_postings as")) {
      this.requestedAccountingBases.push(params[3]);
      return Promise.resolve({ rows: [{
        assets: "680",
        liabilities: "50",
        equity: "630",
        revenue: "150",
        expenses: "20",
        receivables: "75",
        payables: "25",
        overdue_receivables: "10",
        overdue_payables: "5"
      } as unknown as Row] });
    }
    throw new Error(`Unexpected dashboard query: ${sql}`);
  }
}

class VendorBillClient implements PostgresQueryClient {
  billListParams: readonly unknown[] = [];
  billListSql = "";
  billSummarySql = "";

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes("with bill_balances as")) {
      this.billListSql = sql;
      if (params[6] === "partial") this.billListParams = params;
      return Promise.resolve({ rows: [{
        bill_id: "bill_1",
        source_id: "source_1",
        transaction_id: "transaction_bill_1",
        party_id: "vendor_1",
        party_name: "Northwind Security",
        document_number: "BILL-100",
        document_date: "2026-08-01",
        due_date: "2026-08-12",
        currency_code: "USD",
        original_amount: "125",
        open_amount: "75",
        status: "partial",
        version: 2
      }] as unknown as Row[] });
    }
    if (sql.includes('select transaction."memo"') && sql.includes("document_type\" = 'vendor_bill'")) {
      return Promise.resolve({ rows: [{ memo: "Annual security subscription" } as unknown as Row] });
    }
    if (sql.includes('from "erp_financials"."subledger_document_lines" line')) {
      return Promise.resolve({ rows: [{
        line_id: "bill_line_1",
        line_number: 1,
        source_id: "source_1",
        account_id: "expense_security",
        source_account_id: "security-expense",
        source_account_name: "Security expense",
        book_account_mapping_id: "mapping_1",
        book_account_key: "software-security",
        item_id: "item_security",
        source_item_id: "source-item-security",
        item_name: "Security subscription",
        item_expense_account_id: "expense_security",
        customer_party_id: "customer_1",
        customer_name: "Houchens Industries, Inc.",
        description: "Annual security subscription",
        quantity: "1",
        unit_amount: "1.7472",
        discount_amount: "0",
        tax_code: null,
        tax_amount: "0",
        service_period_start: "2026-08-01",
        service_period_end: "2027-07-31",
        dimension_refs: [],
        line_amount: "125"
      }] as unknown as Row[] });
    }
    if (sql.includes('application."source_document_id" as "source_payment_id"')) {
      return Promise.resolve({ rows: [{
        application_id: "application_1",
        source_payment_id: "payment_1",
        application_date: "2026-08-10",
        applied_amount: "50",
        status: "applied",
        version: 1
      }] as unknown as Row[] });
    }
    if (sql.includes("with bills as")) {
      this.billSummarySql = sql;
      return Promise.resolve({ rows: [{
        outstanding_amount: "75",
        outstanding_count: 1,
        overdue_amount: "75",
        overdue_count: 1,
        paid_amount: "50",
        paid_in_period_amount: "50",
        paid_in_period_count: 1,
        settled_count: 0,
        voided_count: 0,
        replaced_count: 0
      }] as unknown as Row[] });
    }
    throw new Error(`Unexpected vendor bill query: ${sql}`);
  }
}

class BillPaymentClient implements PostgresQueryClient {
  paymentListParams: readonly unknown[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes("with payment_rows as")) {
      this.paymentListParams = params;
      return Promise.resolve({ rows: [{
        payment_id: "payment_1",
        source_id: "source_1",
        document_type: "bill_payment",
        transaction_id: "transaction_payment_1",
        party_id: "vendor_1",
        party_name: "Northwind Security",
        document_number: "PAY-100",
        document_date: "2026-08-05",
        currency_code: "USD",
        original_amount: "20",
        open_amount: "0",
        payment_status: "voided",
        version: 2,
        lifecycle_event_id: "event_payment_posted",
        application_count: 0
      }] as unknown as Row[] });
    }
    if (sql.includes("with canonical_bill_payments as") && sql.includes("from filtered")) {
      return Promise.resolve({ rows: [{
        scheduled_amount: "30",
        scheduled_count: 1,
        cleared_amount: "20",
        cleared_count: 1,
        voided_amount: "10",
        voided_count: 1,
        total_amount: "60",
        total_count: 3
      }] as unknown as Row[] });
    }
    if (sql.includes("with canonical_bill_payments as")) {
      return Promise.resolve({ rows: [{
        payment_id: "payment_1",
        source_id: "source_1",
        vendor_id: "vendor_1",
        vendor_name: "Northwind Security",
        document_number: "PAY-100",
        payment_date: "2026-08-05",
        currency_code: "USD",
        amount: "20",
        status: "voided",
        version: 2,
        payment_method: "ach",
        payment_reference: "ACH-100",
        funding_account_id: "account_cash",
        payable_account_id: "account_ap",
        transaction_id: "transaction_payment_1",
        document_version: 4,
        application_status: "voided",
        application_count: 0
      }] as unknown as Row[] });
    }
    if (sql.includes('scheduled."event_id" as "scheduled_event_id"')) {
      return Promise.resolve({ rows: [{
        memo: "Duplicate payment",
        allocations: [{ billId: "bill_1", amount: "10.00", expectedBillVersion: 1 }],
        scheduled_event_id: "event_payment_scheduled",
        scheduled_actor_ref: "user:clerk",
        scheduled_approver_ref: null,
        scheduled_request_id: "request-schedule-payment",
        scheduled_reason_code: "schedule_bill_payment",
        cleared_event_id: "event_payment_cleared",
        cleared_actor_ref: "user:clerk",
        cleared_approver_ref: null,
        cleared_request_id: "request-clear-payment",
        cleared_reason_code: "clear_bill_payment",
        posted_event_id: "event_payment_posted",
        posted_actor_ref: "user:clerk",
        posted_approver_ref: null,
        posted_request_id: "request-post-payment",
        posted_reason_code: "record_bill_payment",
        voided_event_id: "event_payment_voided",
        voided_actor_ref: "user:controller",
        voided_approver_ref: "user:cfo",
        voided_request_id: "request-void-payment",
        voided_reason_code: "duplicate_payment",
        reversal_transaction_id: "transaction_payment_reversal",
        funding_account_id: "account_cash",
        funding_posting_id: "posting_cash",
        funding_debit_amount: "0",
        funding_credit_amount: "20",
        payable_account_id: "account_ap",
        payable_posting_id: "posting_ap",
        payable_debit_amount: "20",
        payable_credit_amount: "0"
      }] as unknown as Row[] });
    }
    if (sql.includes('from "erp_financials"."subledger_applications" application')) {
      return Promise.resolve({ rows: [{
        application_id: "application_1",
        source_id: "source_1",
        application_type: "bill_payment_to_bill",
        status: "unapplied",
        version: 2,
        application_date: "2026-08-10",
        source_payment_id: "payment_1",
        target_document_id: "bill_1",
        applied_amount: "10",
        currency_code: "USD",
        applied_event_id: "event_application_applied",
        ended_event_id: "event_application_unapplied",
        match_candidate_id: null,
        match_decision_id: null,
        match_method: null,
        match_score: null,
        match_evidence: null
      }] as unknown as Row[] });
    }
    throw new Error(`Unexpected bill payment query: ${sql}`);
  }
}

class AdjustmentClient implements PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes("with adjustment_rows as")) {
      return Promise.resolve({ rows: [{
        adjustment_id: "credit_1",
        source_id: "source_1",
        transaction_id: "transaction_1",
        adjustment_type: "credit",
        party_id: "customer_1",
        party_name: "Acme",
        document_number: "CM-1",
        document_date: "2026-08-12",
        currency_code: "USD",
        original_amount: "25",
        open_amount: "0",
        status: "replaced",
        version: 2,
        reversal_transaction_id: "reversal_1",
        replacement_adjustment_id: "credit_2",
        replaces_adjustment_id: null
      } as unknown as Row] });
    }
    if (sql.includes('from "erp_financials"."transactions" transaction')) {
      return Promise.resolve({ rows: [{ memo: "Customer service adjustment" } as unknown as Row] });
    }
    if (sql.includes('from "erp_financials"."subledger_document_lines"')) {
      return Promise.resolve({ rows: [{
        line_id: "credit_line_1",
        line_number: 1,
        account_id: "revenue",
        item_id: null,
        description: "Service credit",
        quantity: "1",
        unit_amount: "25",
        discount_amount: "0",
        tax_code: null,
        tax_amount: "0",
        service_period_start: null,
        service_period_end: null,
        dimension_refs: [],
        line_amount: "25"
      } as unknown as Row] });
    }
    if (sql.includes('from "erp_financials"."ledger_postings" posting')) {
      return Promise.resolve({ rows: [
        {
          posting_id: "posting_1", account_id: "revenue", book_account_key: "revenue",
          account_name: "Revenue", item_id: null, description: "Service credit",
          debit_amount: "25", credit_amount: "0", currency_code: "USD", dimension_refs: []
        },
        {
          posting_id: "posting_2", account_id: "receivable", book_account_key: "receivable",
          account_name: "Accounts Receivable", item_id: null, description: null,
          debit_amount: "0", credit_amount: "25", currency_code: "USD", dimension_refs: []
        }
      ] as unknown as Row[] });
    }
    if (sql.includes('from "erp_financials"."subledger_applications" application')) {
      return Promise.resolve({ rows: [{
        application_id: "application_1",
        invoice_id: "invoice_1",
        application_date: "2026-08-13",
        applied_amount: "5",
        status: "unapplied",
        version: 2
      } as unknown as Row] });
    }
    throw new Error(`Unexpected adjustment query: ${sql}`);
  }
}

class PartyClient implements PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes('from "erp_financials"."parties" party')) {
      return Promise.resolve({ rows: [{
        party_id: "party_vendor_1",
        source_id: "quickbooks_1",
        source_party_id: "42",
        party_type: "vendor",
        display_name: "Secure Supply Co",
        active: true
      } as unknown as Row] });
    }
    throw new Error(`Unexpected party query: ${sql}`);
  }
}

class OperationalDocumentClient implements PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return Promise.resolve({
        rows: [{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" } as unknown as Row]
      });
    }
    if (sql.includes('from "erp_financials"."subledger_documents" document') && sql.includes('accounting_source."source_system"')) {
      return Promise.resolve({ rows: [{
        document_id: "qbo_sales_receipt_1",
        source_id: "quickbooks_1",
        source_system: "quickbooks",
        provider_environment: "production",
        document_type: "sales_receipt",
        transaction_id: "transaction_sales_receipt_1",
        source_transaction_id: "9001",
        source_transaction_type: "SalesReceipt",
        party_id: "customer_1",
        party_name: "Acme",
        document_number: "SR-9001",
        document_date: "2026-08-15",
        due_date: null,
        currency_code: "USD",
        original_amount: "125",
        open_amount: "0",
        status: "settled",
        version: 1
      } as unknown as Row] });
    }
    throw new Error(`Unexpected operational document query: ${sql}`);
  }
}

function operation() {
  return {
    actorRef: "user:1",
    requestId: "request:1",
    correlationId: "correlation:1",
    reasonCode: "test",
    occurredAt: "2026-08-12T12:00:00.000Z"
  } as const;
}

function outboxEvent(): FinancialOutboxEvent {
  return {
    outboxEventId: "outbox_1",
    tenantId: "tenant_1",
    companyId: "company_1",
    bookId: "book_1",
    sourceId: "source_1",
    eventType: "ledger.posted",
    aggregateType: "journal_entry",
    aggregateId: "transaction_1",
    idempotencyKey: "ledger:1",
    payload: {},
    status: "processing",
    attemptCount: 1,
    availableAt: "2026-08-12T12:00:00.000Z",
    createdAt: "2026-08-12T12:00:00.000Z"
  };
}
