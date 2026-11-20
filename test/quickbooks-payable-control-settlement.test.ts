import { describe, expect, it } from "vitest";
import { createQuickBooksJournalProjections, quickBooksPayableControlSourceIds, quickBooksPayableVendorFallbacks } from "../src/quickbooks-journal-projection.js";
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

    // QuickBooks' GL can omit the party on a refund deposit's payable posting; the
    // linking bill payment's vendor then identifies it (Truist 68565/68566 shape).
    const noParty = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_ap", transaction: "101068", account: "ap", credit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(noParty, [payment])]).toEqual(["101068"]);
    expect([...quickBooksPayableVendorFallbacks(noParty, [payment])]).toEqual([["101068", "frontier"]]);
    // Bill payments from different vendors linking the same deposit: no fallback, not selected.
    const otherVendorPayment = billPayment("101099", "14261", [["Deposit", "101068", "10.58"], ["VendorCredit", "99470", "10.58"]]);
    expect([...quickBooksPayableVendorFallbacks(noParty, [payment, otherVendorPayment])]).toEqual([]);
    expect([...quickBooksPayableControlSourceIds(noParty, [payment, otherVendorPayment])]).toEqual([]);
    // Payable postings on a customer are not a vendor scope.
    const customer = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_ap", transaction: "101068", account: "ap", party: "houchens", credit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(customer, [payment])]).toEqual([]);
    // QuickBooks ages a vendor-named payable posting as open even when no bill
    // payment links it (Ben Lomand Telco Deposit 94010): selected without a link.
    expect([...quickBooksPayableControlSourceIds(base, [{ ...payment, sourceTransactionType: "Payment" }])]).toEqual(["101068"]);
    expect([...quickBooksPayableControlSourceIds(base, [])]).toEqual(["101068"]);
    // Without a vendor on the posting and no linking bill payment, nothing names the vendor: not selected.
    expect([...quickBooksPayableControlSourceIds(noParty, [])]).toEqual([]);
    const noPayable = facts({ transactions: [{ id: "101068", type: "Deposit" }], postings: [{ id: "dep_bank", transaction: "101068", account: "bank", debit: "10.58" }] });
    expect([...quickBooksPayableControlSourceIds(noPayable, [payment])]).toEqual([]);
  });

  it("projects an unlinked vendor refund deposit as an open payable that nets the vendor's open credit, as QuickBooks ages it", () => {
    // Ben Lomand Telco: VendorCredit 93706 $38.14 (2024-10-11) refunded by Deposit 94010 $38.14 (2024-10-29)
    // credited to Accounts Payable; no bill payment links them. QuickBooks' AP aging shows both open, vendor total $0.00.
    const base = facts({
      transactions: [{ id: "94010", type: "Deposit" }],
      postings: [
        { id: "dep_bank", transaction: "94010", account: "bank", debit: "38.14" },
        { id: "dep_ap", transaction: "94010", account: "ap", party: "frontier", credit: "38.14" },
      ],
    });
    const plan = createQuickBooksJournalProjections(base, new Set(), quickBooksPayableControlSourceIds(base, []));
    expect(plan.projections.map(row => [row.resource.sourceTransactionType, row.resource.totalAmount, row.metadata.journalSourceId, row.metadata.sourceTransactionType]))
      .toEqual([["JournalPayable", "38.14", "94010", "Deposit"]]);
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

  it("settles a $0 bill payment's vendor credit against a refund deposit whose payable posting names no party", () => {
    // Truist 2021: VendorCredit 68564 $44,785.37 applied by $0 BillPayment 68566 to refund Deposit 68565,
    // whose Accounts Payable posting QuickBooks reports without a party.
    const base = facts({ transactions: [{ id: "68565", type: "Deposit" }], postings: [
      { id: "dep_bank", transaction: "68565", account: "bank", debit: "44785.37" },
      { id: "dep_ap", transaction: "68565", account: "ap", credit: "44785.37" },
    ] });
    const payment = billPayment("68566", "14005", [["Deposit", "68565", "44785.37"], ["VendorCredit", "68564", "44785.37"]]);
    const fallbacks = quickBooksPayableVendorFallbacks(base, [payment]);
    const plan = createQuickBooksJournalProjections(base, new Set(), quickBooksPayableControlSourceIds(base, [payment], fallbacks), fallbacks);
    expect(plan.projections.map(row => [row.resource.sourceTransactionType, row.resource.totalAmount, row.metadata.partyId, row.metadata.journalSourceId]))
      .toEqual([["JournalPayable", "44785.37", "frontier", "68565"]]);
    expect(plan.rewrite(payment).lines.map(line => line.linkedTransactions?.[0]?.sourceTransactionType)).toEqual(["JournalPayable", "VendorCredit"]);
    expect(plan.evidence).toEqual([expect.objectContaining({ sourceTransactionId: "68566", journalSourceId: "68565", amount: "44785.37" })]);
    // Without the fallback map (other SDK users), party-less payables stay unsettled as before.
    expect(createQuickBooksJournalProjections(base, new Set(), new Set()).projections).toEqual([]);
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
