import { describe, expect, it } from "vitest";
import { createFiscalCloseCertificateQueries } from "../src/fiscal-close-certificates.js";

describe("close totals verification input", () => {
  it.each(["", "   ", "x".repeat(1501)])("rejects unbounded or empty certificate identities before reading", async certificateId => {
    let queries = 0;
    const api = createFiscalCloseCertificateQueries({ tenantId: "t", companyId: "c", sourceId: "s", bookId: "b",
      database: { transaction: () => { queries++; throw new Error("must not read"); } } });
    await expect(api.verifyCurrentTotals(certificateId)).rejects.toMatchObject({ code: "invalid_input" });
    expect(queries).toBe(0);
  });
});
