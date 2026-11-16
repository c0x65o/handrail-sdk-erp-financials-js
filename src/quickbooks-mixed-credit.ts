import type { NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";

export class QuickBooksMixedCreditError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function minor(value: string | undefined): bigint {
  if (value === undefined || !/^\d+(?:\.\d{1,2}0*)?$/.test(value)) {
    throw new QuickBooksMixedCreditError("mixed_credit_invalid_amount");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function decimal(value: bigint): string {
  return `${String(value / 100n)}.${String(value % 100n).padStart(2, "0")}`;
}

/** Split only an unambiguous single-document cash + credit settlement.
 * Provider ledger postings and original document amounts are never changed.
 */
export function planQuickBooksMixedCredit(transaction: NormalizedQuickBooksLedgerTransaction) {
  const customer = transaction.sourceTransactionType === "Payment";
  if ((!customer && transaction.sourceTransactionType !== "BillPayment") || Number(transaction.totalAmount) <= 0) return undefined;
  const creditType = customer ? "CreditMemo" : "VendorCredit";
  if (!transaction.lines.some(line => line.linkedTransactions?.some(link => link.sourceTransactionType === creditType))) return undefined;
  const targetType = customer ? "Invoice" : "Bill";
  const cash = minor(transaction.totalAmount);
  const targets: { line: NormalizedQuickBooksLedgerTransaction["lines"][number]; id: string; amount: bigint }[] = [];
  const credits: { id: string; amount: bigint }[] = [];
  const identities = new Set<string>();
  for (const line of transaction.lines) {
    const links = line.linkedTransactions ?? [];
    if (links.length === 0 && (line.sourceAmount === undefined || minor(line.sourceAmount) === 0n)) continue;
    if (links.length !== 1) throw new QuickBooksMixedCreditError("mixed_credit_ambiguous_links");
    const link = links[0];
    if (!link) throw new QuickBooksMixedCreditError("mixed_credit_ambiguous_links");
    const amount = minor(line.sourceAmount);
    if (amount <= 0n || !link.sourceTransactionId || identities.has(link.sourceTransactionId)) {
      throw new QuickBooksMixedCreditError("mixed_credit_invalid_or_duplicate_link");
    }
    identities.add(link.sourceTransactionId);
    if (link.sourceTransactionType === targetType) targets.push({ line, id: link.sourceTransactionId, amount });
    else if (link.sourceTransactionType === creditType) credits.push({ id: link.sourceTransactionId, amount });
    else throw new QuickBooksMixedCreditError("mixed_credit_unsupported_link_type");
  }
  const target = targets[0];
  if (targets.length !== 1 || !target || credits.length === 0) throw new QuickBooksMixedCreditError("mixed_credit_ambiguous_targets");
  if (cash <= 0n || cash + credits.reduce((sum, credit) => sum + credit.amount, 0n) !== target.amount) {
    throw new QuickBooksMixedCreditError("mixed_credit_cash_and_credits_do_not_match_target");
  }
  return {
    cashLines: [{ ...target.line, sourceAmount: decimal(cash) }],
    evidence: { providerLinkedAmount: decimal(target.amount), cashAmount: decimal(cash), creditAmount: decimal(target.amount - cash) },
    allocations: credits.map(credit => ({ sourceDocumentSourceTransactionId: credit.id,
      targetDocumentSourceTransactionId: target.id, amount: decimal(credit.amount) }))
  };
}
