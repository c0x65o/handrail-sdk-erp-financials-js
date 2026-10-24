import { describe, expect, it } from "vitest";
import { createErpFinancialsSdk, type ReceivableCollectionPositionsRequest } from "../src/index.js";

describe("bounded collection position input", () => {
  const sdk = createErpFinancialsSdk({
    tenantId: "tenant", companyId: "company", bookId: "book", writeSourceId: "source", currencyCode: "USD",
    database: { transaction() { return Promise.reject(new Error("Invalid/empty input must not reach the database")); } }
  });
  const request = { sourceId: "source", customerId: "customer", collectionRef: "order", unbilledAmount: "1.00" };
  it("returns an empty result without database access", async () => {
    expect(await sdk.queries.getReceivableCollectionPositions({ requests: [] })).toEqual([]);
    expect(await sdk.queries.getReceivableCollectionCoverageHistory({ requests: [] })).toEqual([]);
  });
  it("guard rejects empty requests before a callback or database access", async () => {
    await expect(sdk.queries.withLockedReceivableCollectionPositions({ requests: [] }, () => Promise.resolve("never"))).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("rejects oversized, duplicate, ambiguous and malformed batches before any database access", async () => {
    const invalid = [null, {}, { requests: null }, { requests: {} },
      { requests: Array.from({ length: 201 }, (_, i) => ({ ...request, collectionRef: String(i) })) },
      { requests: [request, request] }, { requests: [request, { ...request, unbilledAmount: "2.00" }] },
      ...[null, {}, { ...request, customerId: "" }, { ...request, sourceId: "x".repeat(513) },
        { ...request, invoiceId: "invoice" }, { ...request, unbilledAmount: "1.001" }, { ...request, unbilledAmount: "-1.00" }]
        .map(value => ({ requests: [request, value] }))];
    for (const input of invalid) {
      await expect(sdk.queries.getReceivableCollectionPositions(input as ReceivableCollectionPositionsRequest)).rejects.toMatchObject({ code: "invalid_input" });
      await expect(sdk.queries.getReceivableCollectionCoverageHistory(input as ReceivableCollectionPositionsRequest)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });
});
