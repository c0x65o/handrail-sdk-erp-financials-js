import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresStorageAdapter, createPostgresTransactionRunner, migratePostgresSchema } from "../src/index.js";
import type { AccountingCompany } from "../src/index.js";

const url = process.env.ERP_FINANCIALS_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("accounting company ownership", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const storage = createPostgresStorageAdapter(pool);
  const company = (id: string, tenantId = "owner"): AccountingCompany => ({
    companyId: id, tenantId, legalName: "Company", displayName: "Company",
    baseCurrencyCode: "USD", fiscalYearStartMonth: 1, providerEnvironment: "native",
    sourceSystem: "native_erp", sourceCompanyRef: id,
  });
  beforeAll(async () => {
    await migratePostgresSchema(createPostgresTransactionRunner(pool), { appliedByRef: "test:company-scope" });
  });
  afterAll(async () => { await pool.end(); });

  it("rejects a tenant collision even before any dependent books exist", async () => {
    const original = company("scope-company");
    await storage.upsertAccountingCompany(original);
    await expect(storage.upsertAccountingCompany({ ...original, tenantId: "other", legalName: "Replacement" }))
      .rejects.toMatchObject({ code: "scope_mismatch" });
    const { rows } = await pool.query("select tenant_id, legal_name from erp_financials.accounting_companies where company_id = $1", [original.companyId]);
    expect(rows).toEqual([{ tenant_id: "owner", legal_name: "Company" }]);
    expect(await storage.upsertAccountingCompany({ ...original, displayName: "Shared source name" })).toBe(1);
  });

  it("allows exactly one tenant to win simultaneous creation of a global company id", async () => {
    const results = await Promise.allSettled([
      storage.upsertAccountingCompany(company("race-company", "first")),
      storage.upsertAccountingCompany(company("race-company", "second")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toMatchObject({ code: "scope_mismatch" });
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    const { rows } = await pool.query("select tenant_id from erp_financials.accounting_companies where company_id = 'race-company'");
    expect(rows).toEqual([{ tenant_id: winner }]);
  });
});
