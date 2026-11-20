import { describe, expect, it } from "vitest";
import { createQuickBooksJournalProjections, quickBooksPayableControlSourceIds } from "../src/quickbooks-journal-projection.js";
import type { CanonicalAccountingFactSet } from "../src/source-adapters.js";
import type { NormalizedQuickBooksLedgerTransaction } from "../src/normalized-accounting-contracts.js";

type Posting = { id: string; transaction: string; account: string; party?: string; debit?: string; credit?: string };

function facts(input: { transactions: { id: string; type: string }[]; postings: Posting[] }): CanonicalAccountingFactSet {
  return {
    company: { baseCurrencyCode: "USD" },
    accounts: [
      { accountId: "ap", sourceAccountId: "2000", type: "Accounts Payable" },
      { accountId: "bank", sourceAccountId: "1000", type: "Bank" },
    ],
    parties: [
      { partyId: "frontier", sourcePartyId: "14005", partyType: "vendor" },
      { partyId: "harlan", sourcePartyId: "14261", partyType: "vendor" },
      { partyId: "houchens", sourcePartyId: "8564", partyType: "customer" },
    ],
    transactions: input.transactions.map(row => ({ transactionId: `t_${row.id}`, sourceTransactionId: row.id, sourceTransactionType: row.type,
      status: "posted", transactionDate: "2025-10-28", currencyCode: "USD" })),
    postings: input.postings.map(row => ({ postingId: row.id, transactionId: `t_${row.transaction}`, accountId: row.account,
      ...(row.party ? { partyId: row.party } : {}), accountingBasis: "accrual", debitAmount: row.debit ?? "0.00", creditAmount: row.credit ?? "0.00" })),
  } as unknown as CanonicalAccountingFactSet;
}

function billPayment(id: string, party: string, lines: [string, string, string][]): NormalizedQuickBooksLedgerTransaction {
  return { sourceTransactionType: "BillPayment", sourceTransactionId: id, transactionDate: "2025-10-28", totalAmount: "0.00", currencyCode: "USD",
    partyRef: { sourceObjectId: party, partyType: "vendor" },
    lines: lines.map(([type, target, amount], index) => ({ lineNumber: index + 1, sourceLineId: String(index + 1), sourceAmount: amount,
      linkedTransactions: [{ sourceTransactionId: target, sourceTransactionType: type }] })) } as unknown as NormalizedQuickBooksLedgerTransaction;
}

// Frontier BillPayment 101069 (2025-10-28): VendorCredit 99468 $119.33 applied to Bill 101067 $108.75 and refund Deposit 101068 $10.58.
const frontier = () => ({
  facts: facts({
    transactions: [{ id: "101068", type: "Deposit" }],
    postings: [
      { id: "dep_bank", transaction: "101068", account: "bank", debit: "10.58" },
      { id: "dep_ap", transaction: "101068", account: "ap", party: "frontier", credit: "10.58" },
    ],
  }),
  payment: billPayment("101069", "14005", [["Deposit", "101068", "10.58"], ["Bill", "101067", "108.75"], ["VendorCredit", "99468", "119.33"]]),
});

describe("QuickBooks payable purchase/deposit settlement", () => {
  it("selects bill-payment-linked purchases and deposits whose payable postings all name a vendor", () => {
    const { facts: base, payment } = frontier();
    expect([...quickBooksPayableControlSourceIds(base, [payment])]).toEqual(["101068"]);

    // A refund deposit whose payable posting has no party keeps the previous behavior.
    const noParty = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_ap", transaction: "101068", account: "ap", credit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(noParty, [payment])]).toEqual([]);
    // Payable postings on a customer are not a vendor scope.
    const customer = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_ap", transaction: "101068", account: "ap", party: "houchens", credit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(customer, [payment])]).toEqual([]);
    // Not linked from a bill payment, or no payable posting: not selected.
    expect([...quickBooksPayableControlSourceIds(base, [{ ...payment, sourceTransactionType: "Payment" }])]).toEqual([]);
    const noPayable = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_bank", transaction: "101068", account: "bank", debit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(noPayable, [payment])]).toEqual([]);
  });

  it("projects a refund deposit's vendor payable and settles the bill payment link against it", () => {
    const { facts: base, payment } = frontier();
    const plan = createQuickBooksJournalProjections(base, new Set(), quickBooksPayableControlSourceIds(base, [payment]));
    expect(plan.projections.map(row => [row.resource.sourceTransactionType, row.resource.totalAmount, row.metadata.journalSourceId, row.metadata.sourceTransactionType]))
      .toEqual([["JournalPayable", "10.58", "101068", "Deposit"]]);
    const rewritten = plan.rewrite(payment);
    expect(rewritten.lines.map(line => line.linkedTransactions?.[0]?.sourceTransactionType)).toEqual(["JournalPayable", "Bill", "VendorCredit"]);
    expect(plan.evidence).toEqual([expect.objectContaining({ sourceTransactionId: "101069", journalSourceId: "101068", amount: "10.58", allocation: "single_line" })]);
  });

  it("projects a purchase check's vendor payable debit as a vendor credit (Harlan 99576 shape)", () => {
    // Purchase 98417 debits Accounts Payable $1.00 for Harlan Community TV; BillPayment 99576 applies it to Bill 99436.
    const base = facts({ transactions: [{ id: "98417", type: "Purchase" }], postings: [
      { id: "chk_bank", transaction: "98417", account: "bank", credit: "1.00" },
      { id: "chk_ap", transaction: "98417", account: "ap", party: "harlan", debit: "1.00" },
    ] });
    const payment = billPayment("99576", "14261", [["Purchase", "98417", "1.00"], ["Bill", "99436", "1.00"]]);
    const plan = createQuickBooksJournalProjections(base, new Set(), quickBooksPayableControlSourceIds(base, [payment]));
    expect(plan.projections.map(row => row.resource.sourceTransactionType)).toEqual(["JournalVendorCredit"]);
    expect(plan.rewrite(payment).lines.map(line => line.linkedTransactions?.[0]?.sourceTransactionType)).toEqual(["JournalVendorCredit", "Bill"]);
  });

  it("keeps the previous representation when a payable link cannot be settled (all or nothing)", () => {
    const { facts: base } = frontier();
    // Over-application of the deposit's payable, and a party mismatch: neither throws, both stay unsettled.
    const over = billPayment("101069", "14005", [["Deposit", "101068", "50.00"], ["VendorCredit", "99468", "50.00"]]);
    const otherVendor = billPayment("101070", "14261", [["Deposit", "101068", "10.58"], ["VendorCredit", "99468", "10.58"]]);
    const plan = createQuickBooksJournalProjections(base, new Set(), quickBooksPayableControlSourceIds(base, [over, otherVendor]));
    expect(plan.rewrite(over)).toEqual(over);
    expect(plan.rewrite(otherVendor)).toEqual(otherVendor);
    expect(plan.evidence).toEqual([]);
    // Without payable ids (other SDK users), nothing about purchase/deposit links changes.
    const legacy = createQuickBooksJournalProjections(base);
    expect(legacy.projections).toEqual([]);
    expect(legacy.rewrite(frontier().payment)).toEqual(frontier().payment);
  });
});
