import { describe, expect, it } from "vitest";
import { planQuickBooksMixedCredit } from "../src/quickbooks-mixed-credit.js";
import type { NormalizedQuickBooksLedgerTransaction } from "../src/normalized-accounting-contracts.js";

function present<T>(value: T | undefined): T { if (value === undefined) throw Error("Missing fixture"); return value; }

const fixture = (customer = false): NormalizedQuickBooksLedgerTransaction => ({
  sourceTransactionId: "cash-credit-fixture", sourceTransactionType: customer ? "Payment" : "BillPayment",
  transactionDate: "2026-01-01", totalAmount: "30.00",
  lines: [
    { lineNumber: 1, sourceLineId: "bill-line", sourceAmount: "140.00", postings: [], linkedTransactions: [{ sourceTransactionId: "target", sourceTransactionType: customer ? "Invoice" : "Bill" }] },
    { lineNumber: 2, sourceLineId: "credit-line", sourceAmount: "110.00", postings: [], linkedTransactions: [{ sourceTransactionId: "credit", sourceTransactionType: customer ? "CreditMemo" : "VendorCredit" }] }
  ]
});
describe("mixed cash and credit allocation", () => {
  it.each([false, true])("splits cash from credit without changing provider data (customer=%s)", customer => {
    const input = fixture(customer), before = structuredClone(input);
    const plan = planQuickBooksMixedCredit(input);
    expect(plan?.cashLines).toEqual([{ ...input.lines[0], sourceAmount: "30.00" }]);
    expect(plan?.allocations).toEqual([{ sourceDocumentSourceTransactionId: "credit", targetDocumentSourceTransactionId: "target", amount: "110.00" }]);
    expect(plan?.evidence).toEqual({ providerLinkedAmount: "140.00", cashAmount: "30.00", creditAmount: "110.00" });
    expect(input).toEqual(before);
  });
  it.each(["29.99", "-30", "NaN", "30.001"])("does not silently repair an invalid cash amount %s", totalAmount => {
    if (totalAmount.startsWith("-")) expect(planQuickBooksMixedCredit({ ...fixture(), totalAmount })).toBeUndefined();
    else expect(() => planQuickBooksMixedCredit({ ...fixture(), totalAmount })).toThrow();
  });
  it("rejects ambiguous targets, duplicate credits, unsupported links and unlinked nonzero amounts", () => {
    const input = fixture(), first = present(input.lines[0]), second = present(input.lines[1]);
    for (const lines of [
      [...input.lines, { ...first, linkedTransactions: [{ sourceTransactionId: "other", sourceTransactionType: "Bill" }] }],
      [...input.lines, second],
      [...input.lines, { ...first, linkedTransactions: [{ sourceTransactionId: "journal", sourceTransactionType: "JournalEntry" }] }],
      [...input.lines, { ...first, linkedTransactions: [] }],
      [{ ...first, linkedTransactions: [...(first.linkedTransactions ?? []), ...(second.linkedTransactions ?? [])] }, second]
    ]) expect(() => planQuickBooksMixedCredit({ ...input, lines })).toThrow();
  });
  it("leaves ordinary cash and zero-total wrappers to their existing planners", () => {
    expect(planQuickBooksMixedCredit({ ...fixture(), lines: [present(fixture().lines[0])] })).toBeUndefined();
    expect(planQuickBooksMixedCredit({ ...fixture(), totalAmount: "0.00" })).toBeUndefined();
  });
});
