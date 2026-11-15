import type { CanonicalAccountingFactSet } from "./source-adapters.js";
import type { NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";

export class QuickBooksNonCashLinkError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** QBO uses Payment/BillPayment as relationship containers for journal offsets.
 * Journals are canonical transactions, not fabricated invoices or cash payments.
 * Retain each provider allocation as application evidence without new postings.
 */
export function createQuickBooksNonCashLinkPlanner(facts: CanonicalAccountingFactSet) {
  const transactions = new Map(facts.transactions.map(row => [`${row.sourceTransactionType}:${row.sourceTransactionId}`, row]));
  const parties = new Map(facts.parties.map(row => [row.sourcePartyId, row]));
  const postingTransactions = new Set(facts.postings.map(row => row.transactionId));
  const journalParties = new Map<string, Set<string>>();
  for (const posting of facts.postings) {
    if (!posting.partyId) continue;
    const parties = journalParties.get(posting.transactionId) ?? new Set<string>();
    parties.add(posting.partyId); journalParties.set(posting.transactionId, parties);
  }
  return (document: NormalizedQuickBooksLedgerTransaction) => {
    if (!["Payment", "BillPayment"].includes(document.sourceTransactionType) || (document.totalAmount === undefined || Number(document.totalAmount) !== 0)) return undefined;
    const links = document.lines.flatMap(line => line.linkedTransactions ?? []);
    const ordinaryTypes = document.sourceTransactionType === "Payment" ? ["Invoice", "CreditMemo", "Deposit"] : ["Bill", "VendorCredit"];
    if (links.length && links.every(link => ordinaryTypes.includes(link.sourceTransactionType ?? ""))) return undefined;
    const fail = (reason: string): never => { throw new QuickBooksNonCashLinkError(reason); };
    const transaction = transactions.get(`${document.sourceTransactionType}:${document.sourceTransactionId}`);
    if (!transaction) return undefined; // Older hosts omit non-posting headers; retain their existing admission path.
    if (postingTransactions.has(transaction.transactionId)) return fail("zero_cash_wrapper_has_monetary_postings");
    const party = parties.get(document.partyRef?.sourceObjectId ?? "");
    if (!party || party.partyType !== (document.sourceTransactionType === "Payment" ? "customer" : "vendor")) return fail("missing_application_party");
    for (const amount of [document.openAmount, document.unappliedAmount]) {
      if (amount !== undefined && Number(amount) !== 0) return fail("zero_cash_wrapper_has_nonzero_open_amount");
    }
    const identities = new Set<string>();
    const allocations = document.lines.flatMap(line => {
      const refs = line.linkedTransactions ?? [];
      const amount = Number(line.sourceAmount);
      if (!Number.isFinite(amount)) return fail("missing_per_link_amount");
      if (!refs.length && amount === 0) return [];
      if (refs.length !== 1 || amount <= 0) return fail("ambiguous_non_cash_link_amount");
      const ref = refs[0];
      if (!ref || !ref.sourceTransactionType || line.sourceAmount === undefined) return fail("missing_per_link_amount");
      if (!["Invoice", "Bill", "CreditMemo", "VendorCredit", "JournalEntry", "Deposit", "Purchase"].includes(ref.sourceTransactionType ?? "")) return fail("unsupported_linked_transaction_type");
      const target = transactions.get(`${ref.sourceTransactionType}:${ref.sourceTransactionId}`);
      if (!target) return fail("missing_linked_document");
      if (target.partyId && target.partyId !== party.partyId && ref.sourceTransactionType !== "JournalEntry") return fail("application_party_mismatch");
      const targetParties = journalParties.get(target.transactionId);
      if (ref.sourceTransactionType === "JournalEntry" && targetParties?.size && !targetParties.has(party.partyId)) return fail("application_party_mismatch");
      const identity = line.sourceLineId ?? String(line.lineNumber);
      if (identities.has(identity)) return fail("duplicate_application_line");
      identities.add(identity);
      return [{ sourceLineId: identity, targetTransactionId: target.transactionId,
        sourceTransactionType: ref.sourceTransactionType, sourceTransactionId: ref.sourceTransactionId,
        amount: line.sourceAmount, applicationDate: document.transactionDate }];
    });
    return { sourceTransactionId: document.sourceTransactionId, sourceTransactionType: document.sourceTransactionType,
      transactionId: transaction.transactionId, partyId: party.partyId, totalAmount: document.totalAmount,
      classification: allocations.length ? "provider_non_cash_links" : "zero_effect_document", allocations };
  };
}
