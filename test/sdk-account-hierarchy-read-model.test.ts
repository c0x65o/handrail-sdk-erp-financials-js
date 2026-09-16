import { describe, expect, it } from "vitest";

import { createFinancialReadModels } from "../src/index.js";
import type { PostgresQueryClient, PostgresQueryResult } from "../src/index.js";

describe("SDK account hierarchy read models", () => {
  it("uses canonical parents, orders multiple levels, retains inactive parents, and rolls direct postings", async () => {
    const client = new HierarchyReadClient();
    const readModels = createFinancialReadModels({
      database: { transaction: (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    const chart = await readModels.listChartOfAccounts({ asOfDate: "2026-08-20" });
    expect(chart.map((account) => account.bookAccountKey)).toEqual([
      "qbo:saas",
      "qbo:security",
      "qbo:edr"
    ]);
    expect(chart).toEqual([
      expect.objectContaining({
        bookAccountKey: "qbo:saas",
        active: false,
        directBalance: "10.00",
        balance: "160.00"
      }),
      expect.objectContaining({
        bookAccountKey: "qbo:security",
        parentBookAccountKey: "qbo:saas",
        directBalance: "100.00",
        balance: "150.00"
      }),
      expect.objectContaining({
        bookAccountKey: "qbo:edr",
        parentBookAccountKey: "qbo:security",
        directBalance: "50.00",
        balance: "50.00"
      })
    ]);
    expect(chart.some((account) => account.bookAccountKey === "qbo:unused")).toBe(false);
    expect(client.chartSql).toContain('account."parent_account_id"');
    expect(client.chartSql).toContain('case when count(mapping."book_account_key") > 0');

    const statement = await readModels.getFinancialStatement({
      reportName: "profit_and_loss",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-20"
    });
    expect(statement.lines.map((line) => line.bookAccountKey)).toEqual([
      "qbo:saas",
      "qbo:security",
      "qbo:edr"
    ]);
    expect(statement.lines).toEqual([
      expect.objectContaining({ bookAccountKey: "qbo:saas", directAmount: "10.00", amount: "160.00" }),
      expect.objectContaining({ bookAccountKey: "qbo:security", directAmount: "100.00", amount: "150.00" }),
      expect.objectContaining({ bookAccountKey: "qbo:edr", directAmount: "50.00", amount: "50.00" })
    ]);
    expect(statement.totals).toMatchObject({ income: "160.00", netIncome: "160.00" });
    expect(client.statementSql).toContain('account."parent_account_id"');
    expect(client.statementSql).not.toContain('(mapping."book_account_key" is null or book_account."active")');
  });

  it("keeps explicit reporting-book parent overrides authoritative", async () => {
    const client = new HierarchyReadClient(true);
    const readModels = createFinancialReadModels({
      database: { transaction: (work) => work(client) },
      tenantId: "tenant_1",
      companyId: "company_1",
      bookId: "book_1"
    });

    const chart = await readModels.listChartOfAccounts({ asOfDate: "2026-08-20" });
    const mapped = chart.find((account) => account.bookAccountKey === "managed_edr");
    expect(mapped?.parentBookAccountKey).toBe("managed_security");
    expect(mapped?.parentBookAccountKey).not.toBe("qbo:security");
  });
});

class HierarchyReadClient implements PostgresQueryClient {
  chartSql = "";
  statementSql = "";

  constructor(private readonly explicitOverride = false) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('from "erp_financials"."reporting_books"')) {
      return rows([{ base_currency_code: "USD", accounting_basis: "accrual", status: "active" }] as Row[]);
    }
    if (sql.includes("array_agg(account.")) {
      this.chartSql = sql;
      return rows(this.chartRows() as Row[]);
    }
    if (sql.includes('coalesce(sum(posting."net_amount"), 0) as "net_amount"')) {
      this.statementSql = sql;
      return rows(statementRows() as Row[]);
    }
    if (sql.includes('from "erp_financials"."reporting_book_accounts"')) {
      if (!this.explicitOverride) return rows([] as Row[]);
      if (sql.includes('"account_type"')) {
        return rows([
          bookRow("managed_security", undefined, "Managed Security"),
          bookRow("managed_edr", "managed_security", "Managed EDR")
        ] as Row[]);
      }
      return rows([] as Row[]);
    }
    throw new Error(`Unexpected hierarchy read query: ${sql}`);
  }

  private chartRows(): Record<string, unknown>[] {
    const base = chartRows();
    if (!this.explicitOverride) return base;
    return base.map((row) => row.book_account_key === "qbo:edr"
      ? { ...row, book_account_key: "managed_edr", parent_book_account_key: "managed_security" }
      : row);
  }
}

function chartRows(): Record<string, unknown>[] {
  return [
    chartRow("qbo:edr", "qbo:security", "EDR", true, "50"),
    chartRow("qbo:saas", undefined, "Software as a Service", false, "10"),
    chartRow("qbo:unused", undefined, "Unused Legacy Income", false, "0"),
    chartRow("qbo:security", "qbo:saas", "Security", true, "100")
  ];
}

function chartRow(
  key: string,
  parent: string | undefined,
  name: string,
  active: boolean,
  balance: string
): Record<string, unknown> {
  return {
    book_account_key: key,
    source_account_ids: [key],
    account_number: null,
    account_name: name,
    classification: "income",
    account_type: "Income",
    account_subtype: null,
    account_role: null,
    version: null,
    parent_book_account_key: parent ?? null,
    active,
    debit_amount: "0",
    credit_amount: balance,
    balance
  };
}

function statementRows(): Record<string, unknown>[] {
  return [
    statementRow("qbo:edr", "qbo:security", "EDR", "-50"),
    statementRow("qbo:saas", undefined, "Software as a Service", "-10"),
    statementRow("qbo:security", "qbo:saas", "Security", "-100")
  ];
}

function statementRow(key: string, parent: string | undefined, name: string, net: string): Record<string, unknown> {
  return {
    book_account_key: key,
    parent_book_account_key: parent ?? null,
    account_number: null,
    account_name: name,
    classification: "income",
    debit_amount: "0",
    credit_amount: String(Math.abs(Number(net))),
    net_amount: net
  };
}

function bookRow(key: string, parent: string | undefined, name: string): Record<string, unknown> {
  return {
    book_account_key: key,
    account_number: null,
    account_name: name,
    classification: "income",
    account_type: "Income",
    account_subtype: null,
    account_role: "posting",
    version: 1,
    parent_book_account_key: parent ?? null,
    active: true
  };
}

function rows<Row extends Record<string, unknown>>(values: Row[]): Promise<PostgresQueryResult<Row>> {
  return Promise.resolve({ rows: values, rowCount: values.length });
}
