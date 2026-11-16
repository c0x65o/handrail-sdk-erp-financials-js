import { createHash } from "node:crypto";
import type { NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";
import { settlementDecimal, settlementMinor } from "./quickbooks-journal-projection.js";

/** Provider links specify the funding and settled totals, not a pairing of each
 * credit/cash dollar to a target. A non-posting pool retains those independent
 * legs without inventing a funding allocation or changing the cash receipt.
 */
export function planQuickBooksPooledSettlement(document: NormalizedQuickBooksLedgerTransaction) {
  const customer = document.sourceTransactionType === "Payment";
  const journalCredit = customer ? "JournalCustomerCredit" : "JournalVendorCredit";
  if ((!customer && document.sourceTransactionType !== "BillPayment") || settlementMinor(document.totalAmount ?? "0") <= 0n ||
    !document.lines.some(line => line.linkedTransactions?.some(link => link.sourceTransactionType === journalCredit))) return undefined;
  const cash = settlementMinor(document.totalAmount ?? "0");
  const funding = [{ id: document.sourceTransactionId, amount: settlementDecimal(cash), lineId: "cash" }];
  const targets: typeof funding = [];
  const identities = new Set<string>();
  for (const line of document.lines) {
    const links = line.linkedTransactions ?? [], link = links[0];
    if (!links.length && settlementMinor(line.sourceAmount ?? "0") === 0n) continue;
    if (links.length !== 1 || !link || settlementMinor(line.sourceAmount ?? "0") <= 0n) throw Error("journal_pool_invalid_link");
    const lineId = line.sourceLineId ?? String(line.lineNumber);
    if (identities.has(lineId)) throw Error("journal_pool_duplicate_line");
    identities.add(lineId);
    const leg = { id: link.sourceTransactionId, amount: settlementDecimal(settlementMinor(line.sourceAmount ?? "0")), lineId };
    if ([journalCredit, customer ? "CreditMemo" : "VendorCredit"].includes(link.sourceTransactionType ?? "")) funding.push(leg);
    else if ([customer ? "Invoice" : "Bill", customer ? "JournalReceivable" : "JournalPayable"].includes(link.sourceTransactionType ?? "")) targets.push(leg);
    else throw Error("journal_pool_unsupported_link");
  }
  const total = funding.reduce((sum, leg) => sum + settlementMinor(leg.amount), 0n);
  if (!targets.length || targets.reduce((sum, leg) => sum + settlementMinor(leg.amount), 0n) !== total) throw Error("journal_pool_unbalanced_legs");
  const id = `journal_pool_${createHash("sha256").update(JSON.stringify([document.sourceTransactionType,document.sourceTransactionId])).digest("hex")}`;
  return { id, source: document, funding, targets, amount: settlementDecimal(total), cashAmount: settlementDecimal(cash), side: customer ? "receivables" : "payables",
    resource: { sourceTransactionId: id, sourceTransactionType: "JournalSettlementPool", totalAmount: settlementDecimal(total),
      transactionDate: document.transactionDate, ...(document.transactionNumber ? { transactionNumber: document.transactionNumber } : {}),
      ...(document.currencyCode ? {currencyCode:document.currencyCode}:{}), ...(document.partyRef ? {partyRef:document.partyRef}:{}), lines: [] } };
}
