import { describe, expect, it } from "vitest";
import { createQuickBooksNonCashLinkPlanner } from "../src/quickbooks-non-cash-links.js";
import { ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES, mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts } from "../src/index.js";
import type { NormalizedQuickBooksLedgerTransaction } from "../src/index.js";

function fixture(type: "Payment" | "BillPayment") {
  const { facts } = mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync.response, { companyId: "noncash-fixture" });
  const party = { ...requiredFixtureValue(facts.parties[0]), partyId: "party", sourcePartyId: "provider-party", partyType: type === "Payment" ? "customer" as const : "vendor" as const };
  const transactions = ["wrapper", "journal-a", "journal-b"].map((id, i) => ({ ...requiredFixtureValue(facts.transactions[0]), transactionId: id, sourceTransactionId: id,
    sourceTransactionType: i ? "JournalEntry" : type, partyId: party.partyId }));
  const document: NormalizedQuickBooksLedgerTransaction = { sourceTransactionId: "wrapper", sourceTransactionType: type, transactionDate: "2026-01-31",
    totalAmount: "0.00", openAmount: "0.00", partyRef: { sourceObjectId: party.sourcePartyId, partyType: party.partyType },
    lines: ["journal-a", "journal-b"].map((id, i) => ({ sourceLineId: String(i), lineNumber: i + 1, sourceAmount: "125.00", postings: [],
      linkedTransactions: [{ sourceTransactionType: "JournalEntry", sourceTransactionId: id }] })) };
  return { facts: { ...facts, parties: [party], transactions, postings: [] }, document };
}
describe("non-cash provider application evidence", () => {
  it.each(["Payment", "BillPayment"] as const)("retains %s journal links with source amounts and no fabricated cash", type => {
    const { facts, document } = fixture(type);
    const original = structuredClone({ facts, document });
    const plan = requiredFixtureValue(createQuickBooksNonCashLinkPlanner(facts)(document));
    expect(plan.classification).toBe("provider_non_cash_links");
    expect(plan.allocations.map(row => [row.targetTransactionId, row.amount])).toEqual([["journal-a", "125.00"], ["journal-b", "125.00"]]);
    expect({ facts, document }).toEqual(original);
    expect(createQuickBooksNonCashLinkPlanner(facts)(document)).toEqual(plan);
  });
  it("retains empty zero-effect documents and rejects malformed or unresolved applications", () => {
    const { facts, document } = fixture("Payment");
    const plan = createQuickBooksNonCashLinkPlanner(facts);
    expect(plan({ ...document, lines: [] })?.classification).toBe("zero_effect_document");
    expect(() => plan({ ...document, openAmount: "1" })).toThrow("nonzero_open_amount");
    expect(() => plan({ ...document, lines: [{ ...requiredFixtureValue(document.lines[0]), sourceAmount: "-125" }] })).toThrow("ambiguous_non_cash_link_amount");
    expect(() => plan({ ...document, lines: [{ ...requiredFixtureValue(document.lines[0]), linkedTransactions: [{ sourceTransactionType: "JournalEntry", sourceTransactionId: "missing" }] }] })).toThrow("missing_linked_document");
    expect(() => plan({ ...document, lines: [requiredFixtureValue(document.lines[0]), requiredFixtureValue(document.lines[0])] })).toThrow("duplicate_application_line");
    const posting = { ...requiredFixtureValue(mapNormalizedQuickBooksFullSyncResponseToCanonicalFacts(ERP_FINANCIALS_NORMALIZED_QUICKBOOKS_SYNC_FIXTURES.fullSync.response, { companyId: "noncash-fixture" }).facts.postings[0]), transactionId: "wrapper" };
    expect(() => createQuickBooksNonCashLinkPlanner({ ...facts, postings: [posting] })(document)).toThrow("has_monetary_postings");
  });
});

function requiredFixtureValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
