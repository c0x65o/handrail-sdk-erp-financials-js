import { describe, expect, it } from "vitest";

import { createFinancialReadModels, createReportingBookService } from "../src/index.js";

import type {
  ErpFinancialsTransactionRunner,
  FinancialOperationContext,
  PostgresQueryClient,
  PostgresQueryResult
} from "../src/index.js";

describe("general-ledger public contract", () => {
  it("applies one strict filter contract to list and summary and binds cursors to it", async () => {
    const client = new LedgerClient();
    const queries = createFinancialReadModels({
      database: runner(client),
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });
    const filters = {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accountingMethod: "cash" as const,
      accountKey: "service_revenue",
      sourceId: "source_1",
      transactionType: "Invoice",
      classId: "class_cyber",
      dimensionKind: "department",
      dimensionId: "department_services",
      polarity: "credit" as const,
      search: "INV-1001"
    };

    const page = await queries.listGeneralLedger({ ...filters, limit: 1 });
    expect(page.items).toEqual([
      expect.objectContaining({
        postingId: "posting_2",
        postingDate: "2026-08-15",
        accountingBasis: "cash",
        transactionType: "Invoice",
        omittedDimensionCount: 1,
        sourceProvenance: {
          sourceId: "source_1",
          sourceRole: "active",
          sourceSystem: "native_erp",
          providerEnvironment: "production",
          sourceTransactionType: "Invoice",
          sourceTransactionId: "invoice_1001",
          sourcePostingId: "invoice_1001:revenue",
          sourceObjectType: "Invoice",
          sourceObjectId: "1001",
          checksum: "a".repeat(64)
        }
      })
    ]);
    expect(page.items[0]?.dimensions).toHaveLength(20);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(client.listParams.slice(5, 15)).toEqual([
      "2026-08-01",
      "2026-08-31",
      "service_revenue",
      "source_1",
      "Invoice",
      "class_cyber",
      "department",
      "department_services",
      "credit",
      "INV-1001"
    ]);
    expect(client.listSql).toContain("jsonb_array_elements");
    expect(client.listSql).toContain("strpos(lower(concat_ws");
    expect(client.listSql).toContain("with recursive effective_accounts");
    expect(client.listSql).toContain("join selected_account_keys selected");

    await expect(queries.getGeneralLedgerSummary(filters)).resolves.toMatchObject({
      accountingBasis: "cash",
      postingCount: 2,
      totalDebits: "10.00",
      totalCredits: "25.00",
      difference: "-15.00"
    });
    expect(client.summaryParams.slice(5)).toEqual(client.listParams.slice(5, 15));
    expect(client.summarySql).toContain("with recursive effective_accounts");
    expect(client.summarySql).toContain('select "book_account_key" from selected_account_keys');

    if (page.nextCursor === undefined) throw new Error("Expected paginated ledger cursor");
    await expect(queries.listGeneralLedger({
      ...filters,
      sourceId: "source_2",
      cursor: page.nextCursor
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.listGeneralLedger({
      ...filters,
      accountingMethod: "accrual",
      cursor: page.nextCursor
    })).rejects.toMatchObject({ code: "invalid_input" });

    await expect(queries.getGeneralLedgerSummary({
      periodStart: filters.periodStart,
      periodEnd: filters.periodEnd
    })).resolves.toMatchObject({ accountingBasis: "accrual" });
    expect(client.summaryParams[3]).toBe("accrual");
  });

  it("rejects invalid dates, dimensions, polarity, search, and page bounds before querying", async () => {
    const client = new LedgerClient();
    const queries = createFinancialReadModels({
      database: runner(client), tenantId: "tenant_1", companyId: "company_1", bookId: "book_1"
    });
    const base = { periodStart: "2026-08-01", periodEnd: "2026-08-31" };

    await expect(queries.listGeneralLedger({ ...base, periodStart: "2026-02-30" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getGeneralLedgerSummary({ ...base, dimensionKind: "class" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getGeneralLedgerSummary({ ...base, polarity: "both" as "debit" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getGeneralLedgerSummary({ ...base, accountingMethod: "modified_cash" as "cash" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.getGeneralLedgerSummary({ ...base, search: "x".repeat(101) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queries.listGeneralLedger({ ...base, limit: 201 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.calls).toHaveLength(0);
  });
});

describe("versioned reporting-book account contract", () => {
  it("requires role/version input and emits a version-checked, replay-safe mutation", async () => {
    const client = new AccountClient();
    const books = createReportingBookService({
      database: runner(client),
      tenantId: "tenant_1",
      companyId: "company_1",
      now: () => "2026-08-15T12:00:00.000Z"
    });

    const account = await books.defineAccount({
      operation: operation("request-account-create"),
      bookId: "book_1",
      bookAccountKey: "service_revenue",
      accountNumber: "4010",
      name: "Service revenue",
      classification: "income",
      accountRole: "posting",
      expectedVersion: 0
    });

    expect(account).toMatchObject({ accountRole: "posting", version: 1, active: true });
    expect(client.mutationSql).toContain('"version" = $18');
    expect(client.mutationSql).toContain('"last_operation_request_id"');
    expect(client.mutationParams[17]).toBe(0);
    expect(client.mutationParams[16]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("validates parent role and expectedVersion before account mutation", async () => {
    const parentClient = new AccountClient({ parentRole: "posting" });
    const books = createReportingBookService({
      database: runner(parentClient), tenantId: "tenant_1", companyId: "company_1"
    });

    await expect(books.defineAccount({
      operation: operation("request-child-create"),
      bookId: "book_1",
      bookAccountKey: "child",
      name: "Child",
      classification: "income",
      accountRole: "posting",
      parentBookAccountKey: "parent",
      expectedVersion: 0
    })).rejects.toMatchObject({ code: "invalid_account_hierarchy" });
    await expect(books.defineAccount({
      operation: operation("request-invalid-version"),
      bookId: "book_1",
      bookAccountKey: "invalid",
      name: "Invalid",
      classification: "income",
      accountRole: "posting",
      expectedVersion: -1
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("distinguishes stale optimistic versions from request-id reuse", async () => {
    const staleBooks = createReportingBookService({
      database: runner(new AccountClient({ mutationMiss: {
        version: 4,
        last_operation_request_id: "another-request",
        last_operation_checksum: "b".repeat(64)
      } })),
      tenantId: "tenant_1",
      companyId: "company_1"
    });
    await expect(staleBooks.defineAccount({
      operation: operation("request-stale"),
      bookId: "book_1",
      bookAccountKey: "service_revenue",
      name: "Service revenue",
      classification: "income",
      accountRole: "posting",
      expectedVersion: 3
    })).rejects.toMatchObject({
      code: "optimistic_concurrency_conflict",
      retryable: true,
      details: { expectedVersion: 3, actualVersion: 4 }
    });

    const reusedBooks = createReportingBookService({
      database: runner(new AccountClient({ mutationMiss: {
        version: 1,
        last_operation_request_id: "request-reused",
        last_operation_checksum: "c".repeat(64)
      } })),
      tenantId: "tenant_1",
      companyId: "company_1"
    });
    await expect(reusedBooks.defineAccount({
      operation: operation("request-reused"),
      bookId: "book_1",
      bookAccountKey: "service_revenue",
      name: "Different input",
      classification: "income",
      accountRole: "posting",
      expectedVersion: 1
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});

class LedgerClient implements PostgresQueryClient {
  readonly calls: string[] = [];
  listSql = "";
  listParams: readonly unknown[] = [];
  summaryParams: readonly unknown[] = [];
  summarySql = "";

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(sql);
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return result([{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" }]);
    }
    if (sql.includes('select count(*)::integer as "posting_count"')) {
      this.summarySql = sql;
      this.summaryParams = params;
      return result([{ posting_count: 2, debits: "10", credits: "25" }]);
    }
    if (sql.includes('accounting_source."source_system"')) {
      this.listSql = sql;
      this.listParams = params;
      return result([ledgerRow("posting_2"), ledgerRow("posting_1")]);
    }
    throw new Error(`Unexpected ledger query: ${sql}`);
  }
}

class AccountClient implements PostgresQueryClient {
  mutationSql = "";
  mutationParams: readonly unknown[] = [];

  constructor(private readonly options: {
    readonly parentRole?: "header" | "posting";
    readonly mutationMiss?: Readonly<Record<string, unknown>>;
  } = {}) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.startsWith("select pg_advisory_xact_lock")) return result([]);
    if (sql.includes('select book."base_currency_code"')) {
      return result([{
        base_currency_code: "USD",
        ...(params[3] === undefined ? {} : {
          parent_classification: "income",
          parent_account_role: this.options.parentRole ?? "header",
          parent_active: true
        })
      }]);
    }
    if (sql.startsWith('insert into "erp_financials"."reporting_book_accounts"')) {
      this.mutationSql = sql;
      this.mutationParams = params;
      if (this.options.mutationMiss !== undefined) return result([]);
      return result([{
        book_account_id: params[0], tenant_id: params[1], company_id: params[2], book_id: params[3],
        book_account_key: params[4], account_number: params[5] ?? null, name: params[6],
        classification: params[7], account_type: params[8] ?? null, account_subtype: params[9] ?? null,
        account_role: params[10], parent_book_account_key: params[11] ?? null, currency_code: params[12] ?? null,
        active: params[13], version: 1, created_at: params[14], updated_at: params[14]
      }]);
    }
    if (sql.startsWith('select * from "erp_financials"."reporting_book_accounts"')) {
      return result(this.options.mutationMiss === undefined ? [] : [this.options.mutationMiss]);
    }
    if (sql.startsWith('select "version", "last_operation_request_id"')) {
      return result(this.options.mutationMiss === undefined ? [] : [this.options.mutationMiss]);
    }
    if (sql.startsWith('select "book_account_key", "parent_book_account_key"')) {
      return result([{ book_account_key: "service_revenue", parent_book_account_key: null }]);
    }
    throw new Error(`Unexpected account query: ${sql}`);
  }
}

function runner(client: PostgresQueryClient): ErpFinancialsTransactionRunner {
  return { transaction: (work) => work(client) };
}

function operation(requestId: string): FinancialOperationContext {
  return {
    actorRef: "user:accountant",
    requestId,
    correlationId: `correlation:${requestId}`,
    reasonCode: "chart_administration",
    occurredAt: "2026-08-15T12:00:00.000Z"
  };
}

function ledgerRow(postingId: string): Record<string, unknown> {
  return {
    posting_id: postingId,
    source_id: "source_1",
    source_posting_id: "invoice_1001:revenue",
    transaction_id: "transaction_1",
    source_transaction_id: "invoice_1001",
    source_transaction_type: "Invoice",
    transaction_number: "INV-1001",
    transaction_date: "2026-08-15",
    posting_date: "2026-08-15",
    accounting_basis: "cash",
    account_id: "account_income",
    book_account_key: "service_revenue",
    account_number: "4010",
    account_name: "Service revenue",
    party_id: "customer_1",
    item_id: null,
    description: "Managed services",
    debit_amount: "0",
    credit_amount: "25",
    net_amount: "-25",
    currency_code: "USD",
    dimension_refs: Array.from({ length: 21 }, (_, index) => ({
      dimensionKind: index === 0 ? "class" : "department",
      dimensionId: index === 0 ? "class_cyber" : `department_${String(index)}`,
      sourceDimensionId: index === 0 ? "class_cyber" : `source_department_${String(index)}`,
      name: index === 0 ? "Cyber" : `Department ${String(index)}`
    })),
    source_role: "active",
    source_system: "native_erp",
    provider_environment: "production",
    source_payload_ref: {
      sourceObjectType: "Invoice",
      sourceObjectId: "1001",
      checksum: "a".repeat(64)
    }
  };
}

function result<Row extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[]
): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: rows as readonly Row[], rowCount: rows.length });
}
