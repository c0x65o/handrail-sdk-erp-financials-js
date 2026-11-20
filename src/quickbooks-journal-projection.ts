import { createHash } from "node:crypto";
import type { CanonicalAccountingFactSet } from "./source-adapters.js";
import type { NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";
import { planJournalSettlement, type JournalSettlementScope } from "./quickbooks-journal-settlement.js";

export const journalProjectionKinds = {
  JournalReceivable: "journal_receivable", JournalPayable: "journal_payable",
  JournalCustomerCredit: "journal_customer_credit", JournalVendorCredit: "journal_vendor_credit"
} as const;
export function settlementMinor(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2}0*)?$/.test(value)) throw Error("journal_settlement_invalid_amount");
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -amount : amount;
}
export function settlementDecimal(value: bigint): string {
  const positive = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${String(positive / 100n)}.${String(positive % 100n).padStart(2, "0")}`;
}
export type JournalSettlementEvidence = {
  sourceTransactionType: string; sourceTransactionId: string; documentNumber: string | null; date: string;
  sourceLineId: string; journalSourceId: string; partySourceId: string; accountSourceId: string;
  amount: string; allocation: string; lineIds: string[]; reason: string | null;
};

const PAYABLE_CONTROL_LINK_TYPES: ReadonlySet<string> = new Set(["Purchase", "Check", "Expense", "Deposit"]);

/**
 * Purchase checks and deposits that post to Accounts Payable for a vendor (a
 * vendor refund deposited, or a check that credits or charges the vendor's
 * payable). QuickBooks ages them as open AP items and settles them through bill
 * payments that link them, so their payable scope becomes a subledger item.
 * Only transactions whose every accrual payable posting names a vendor (or
 * whose linking bill payments name one vendor) qualify; anything else keeps the
 * previous behavior.
 */
/**
 * The vendor of the bill payments that link a purchase/deposit, when every such
 * bill payment names the same vendor. QuickBooks' general ledger can omit the
 * party on a refund deposit's Accounts Payable posting; the $0 bill payment
 * that applies the vendor credit to that deposit identifies the vendor.
 */
export function quickBooksPayableVendorFallbacks(
  facts: CanonicalAccountingFactSet,
  documents: readonly NormalizedQuickBooksLedgerTransaction[],
): Map<string, string> {
  const vendorsBySource = new Map(facts.parties.filter(party => party.partyType === "vendor").map(party => [party.sourcePartyId, party.partyId]));
  const vendorsByLinked = new Map<string, Set<string | undefined>>();
  for (const document of documents) {
    if (document.sourceTransactionType !== "BillPayment") continue;
    const vendor = vendorsBySource.get(document.partyRef?.sourceObjectId ?? "");
    for (const link of document.lines.flatMap(line => line.linkedTransactions ?? [])) {
      if (!PAYABLE_CONTROL_LINK_TYPES.has(link.sourceTransactionType ?? "")) continue;
      const set = vendorsByLinked.get(link.sourceTransactionId) ?? new Set<string | undefined>();
      set.add(vendor); vendorsByLinked.set(link.sourceTransactionId, set);
    }
  }
  return new Map([...vendorsByLinked].flatMap(([sourceId, vendors]) => {
    const [vendor] = [...vendors];
    return vendors.size === 1 && vendor !== undefined ? [[sourceId, vendor] as const] : [];
  }));
}

export function quickBooksPayableControlSourceIds(
  facts: CanonicalAccountingFactSet,
  documents: readonly NormalizedQuickBooksLedgerTransaction[],
  vendorFallbacks: ReadonlyMap<string, string> = quickBooksPayableVendorFallbacks(facts, documents),
): Set<string> {
  // QuickBooks ages every Accounts Payable line that names a vendor as an open
  // item until something is applied to it, whether or not a bill payment links
  // it (Ben Lomand Telco Deposit 94010 refunds VendorCredit 93706; QuickBooks
  // shows both open and the vendor at $0.00). Bill payment links settle them below.
  const payables = new Set(facts.accounts.filter(account => account.type.toLowerCase().replace(/[^a-z]/g, "") === "accountspayable").map(account => account.accountId));
  if (payables.size === 0) return new Set();
  const vendors = new Set(facts.parties.filter(party => party.partyType === "vendor").map(party => party.partyId));
  const candidates = new Map(facts.transactions
    .filter(row => (row.sourceTransactionType === "Purchase" || row.sourceTransactionType === "Deposit") && row.status === "posted")
    .map(row => [row.transactionId, row.sourceTransactionId]));
  const qualified = new Map<string, boolean>();
  for (const posting of facts.postings) {
    const sourceId = candidates.get(posting.transactionId);
    if (sourceId === undefined || posting.accountingBasis !== "accrual" || !payables.has(posting.accountId)) continue;
    if (settlementMinor(posting.debitAmount) - settlementMinor(posting.creditAmount) === 0n) continue;
    const partyId = posting.partyId ?? vendorFallbacks.get(sourceId);
    qualified.set(sourceId, (qualified.get(sourceId) ?? true) && partyId !== undefined && vendors.has(partyId));
  }
  return new Set([...qualified].filter(([, ok]) => ok).map(([sourceId]) => sourceId));
}

/** Subledger projections reference the existing journal. They never enter the
 * canonical fact writer, manufacture an invoice/bill, or create a posting.
 */
export function createQuickBooksJournalProjections(
  facts: CanonicalAccountingFactSet,
  purchaseIds: ReadonlySet<string> = new Set(),
  payableIds: ReadonlySet<string> = new Set(),
  payableVendorFallbacks: ReadonlyMap<string, string> = new Map(),
) {
  const accounts = new Map(facts.accounts.map(row => [row.accountId, row]));
  const parties = new Map(facts.parties.map(row => [row.partyId, row]));
  const transactions = new Map(facts.transactions.map(row => [row.transactionId, row]));
  const journalBySourceId = new Map(facts.transactions.filter(row => (row.sourceTransactionType === "JournalEntry"
    || (row.sourceTransactionType === "Purchase" && purchaseIds.has(row.sourceTransactionId))
    || ((row.sourceTransactionType === "Purchase" || row.sourceTransactionType === "Deposit") && payableIds.has(row.sourceTransactionId)))).map(row => [row.sourceTransactionId, row]));
  const partyBySourceId = new Map(facts.parties.map(row => [row.sourcePartyId, row]));
  const controls = new Map<string, "ar" | "ap">(facts.accounts.flatMap<readonly [string, "ar" | "ap"]>(account => {
    const type = account.type.toLowerCase().replace(/[^a-z]/g, "");
    return type === "accountsreceivable" ? [[account.accountId, "ar" as const] as const] :
      type === "accountspayable" ? [[account.accountId, "ap" as const] as const] : [];
  }));
  const groups = new Map<string, JournalSettlementScope>();
  const paymentAccounts = new Map<string, Set<string>>();
  for (const posting of facts.postings) {
    if (posting.accountingBasis !== "accrual") continue;
    const side = controls.get(posting.accountId);
    if (!side) continue;
    const transaction = transactions.get(posting.transactionId);
    if (!transaction || transaction.status !== "posted") continue;
    const scoped = transaction.sourceTransactionType === "JournalEntry"
      || (transaction.sourceTransactionType === "Purchase" && purchaseIds.has(transaction.sourceTransactionId) && side === "ar")
      || ((transaction.sourceTransactionType === "Purchase" || transaction.sourceTransactionType === "Deposit") && payableIds.has(transaction.sourceTransactionId) && side === "ap");
    if (!scoped) {
      const set = paymentAccounts.get(transaction.sourceTransactionId) ?? new Set<string>();
      set.add(posting.accountId); paymentAccounts.set(transaction.sourceTransactionId, set); continue;
    }
    const net = settlementMinor(posting.debitAmount) - settlementMinor(posting.creditAmount);
    // A payable purchase/deposit posting without a party belongs to the vendor of
    // the bill payments that link it (only when they all name the same vendor).
    const partyId = posting.partyId ?? (transaction.sourceTransactionType !== "JournalEntry" && side === "ap"
      && payableIds.has(transaction.sourceTransactionId) ? payableVendorFallbacks.get(transaction.sourceTransactionId) : undefined);
    if (!partyId) { if (net !== 0n) throw Error(`journal_settlement_missing_party:${transaction.sourceTransactionId}:${posting.accountId}`); continue; }
    const party = parties.get(partyId);
    if (!party || party.partyType !== (side === "ar" ? "customer" : "vendor")) throw Error(`journal_settlement_invalid_party:${transaction.sourceTransactionId}`);
    const key = JSON.stringify([transaction.transactionId, partyId, posting.accountId]);
    const prior = groups.get(key);
    const amount = side === "ar" ? net : -net;
    const lineId = posting.transactionLineId ?? posting.postingId;
    const lines = new Map((prior?.lines ?? []).map(line => [line.lineId, line.openMinor]));
    lines.set(lineId, (lines.get(lineId) ?? 0n) + amount);
    groups.set(key, { journalId: transaction.sourceTransactionId, partyId, accountId: posting.accountId,
      openMinor: (prior?.openMinor ?? 0n) + amount, lines: [...lines].map(([lineId, openMinor]) => ({lineId, openMinor})), lineBalancesKnown: true });
  }
  const zeroScopesByParty = new Map<string, Set<string>>();
  for (const group of groups.values()) if (group.openMinor === 0n) {
    const key = JSON.stringify([group.partyId, controls.get(group.accountId)]);
    const ids = zeroScopesByParty.get(key) ?? new Set<string>(); ids.add(group.journalId); zeroScopesByParty.set(key, ids);
  }
  const projections = [...groups].flatMap(([key, group]) => {
    if (group.openMinor === 0n) return [];
    const transaction = journalBySourceId.get(group.journalId);
    const party = parties.get(group.partyId), account = accounts.get(group.accountId);
    if (!transaction || !party || !account) throw Error("journal_settlement_missing_scope");
    const side = controls.get(group.accountId), credit = group.openMinor < 0n;
    const sourceTransactionType = side === "ar" ? (credit ? "JournalCustomerCredit" : "JournalReceivable") : (credit ? "JournalVendorCredit" : "JournalPayable");
    const id = `journal_scope_${createHash("sha256").update(key).digest("hex")}`;
    const resource: NormalizedQuickBooksLedgerTransaction = { sourceTransactionId: id, sourceTransactionType,
      transactionDate: transaction.transactionDate, transactionNumber: transaction.transactionNumber ?? `Journal ${group.journalId}`,
      totalAmount: settlementDecimal(credit ? -group.openMinor : group.openMinor), currencyCode: transaction.currencyCode,
      partyRef: { sourceObjectId: party.sourcePartyId, partyType: party.partyType }, lines: [] };
    return [{ id, group, transaction: { ...transaction, partyId: group.partyId }, resource,
      metadata: { journalSourceId: group.journalId, journalTransactionId: transaction.transactionId,
        partyId: group.partyId, accountId: group.accountId, partySourceId: party.sourcePartyId, accountSourceId: account.sourceAccountId,
        sourceTransactionType: transaction.sourceTransactionType, projectionRole: sourceTransactionType } }];
  });
  const byId = new Map(projections.map(row => [row.id, row]));
  const candidatesByIdentity = new Map<string, typeof projections>();
  for (const projection of projections) {
    const identity = JSON.stringify([projection.resource.sourceTransactionType, projection.group.journalId, projection.group.partyId]);
    const rows = candidatesByIdentity.get(identity) ?? []; rows.push(projection); candidatesByIdentity.set(identity, rows);
  }
  const balances = new Map(projections.map(row => [row.id, row.group.openMinor < 0n ? { ...row.group, openMinor: -row.group.openMinor, lines: row.group.lines.map(line => ({ ...line, openMinor: -line.openMinor })) } : row.group]));
  const evidence: JournalSettlementEvidence[] = [];
  const evidenceByLine = new Map<string, JournalSettlementEvidence>();
  const lineKey = (sourceId: string, lineId: string) => JSON.stringify([sourceId, lineId]);
  const payableLink = (document: NormalizedQuickBooksLedgerTransaction, link: { sourceTransactionType?: string; sourceTransactionId: string }) =>
    document.sourceTransactionType === "BillPayment" && PAYABLE_CONTROL_LINK_TYPES.has(link.sourceTransactionType ?? "") && payableIds.has(link.sourceTransactionId);
  /** Payable purchase/deposit links settle all-or-nothing per document; otherwise
   * the document keeps its previous (unsettled) representation. */
  function rewrite(document: NormalizedQuickBooksLedgerTransaction): NormalizedQuickBooksLedgerTransaction {
    if (!document.lines.some(line => (line.linkedTransactions ?? []).some(link => payableLink(document, link)))) return rewriteLinks(document, false);
    const balanceSnapshot = new Map(balances), evidenceLength = evidence.length;
    try {
      return rewriteLinks(document, true);
    } catch {
      balances.clear(); for (const [id, scope] of balanceSnapshot) balances.set(id, scope);
      for (const record of evidence.splice(evidenceLength)) evidenceByLine.delete(lineKey(record.sourceTransactionId, record.sourceLineId));
      return rewriteLinks(document, false);
    }
  }
  function rewriteLinks(document: NormalizedQuickBooksLedgerTransaction, settlePayables: boolean): NormalizedQuickBooksLedgerTransaction {
    if (!["Payment", "BillPayment"].includes(document.sourceTransactionType) || settlementMinor(document.totalAmount ?? "0") < 0n) return document;
    if (settlementMinor(document.totalAmount ?? "0") === 0n) {
      const party = partyBySourceId.get(document.partyRef?.sourceObjectId ?? "");
      const links = document.lines.flatMap(line => line.linkedTransactions ?? []);
      const zeroScopes = zeroScopesByParty.get(JSON.stringify([party?.partyId, document.sourceTransactionType === "Payment" ? "ar" : "ap"]));
      // A wrapper linking only internally offset journal scopes has no open
      // subledger balance to consume. Existing non-cash evidence retains it.
      if (links.length && links.every(link => link.sourceTransactionType === "JournalEntry" && zeroScopes?.has(link.sourceTransactionId))) return document;
    }
    return { ...document, lines: document.lines.map(line => {
      const links = line.linkedTransactions ?? [];
      if (!links.some(link => link.sourceTransactionType === "JournalEntry"
        || (["Purchase", "Check", "Expense"].includes(link.sourceTransactionType ?? "") && purchaseIds.has(link.sourceTransactionId))
        || (settlePayables && payableLink(document, link)))) return line;
      const link = links[0];
      if (links.length !== 1 || !link || !line.sourceAmount) throw Error(`journal_settlement_ambiguous_link:${document.sourceTransactionId}`);
      const party = partyBySourceId.get(document.partyRef?.sourceObjectId ?? "");
      if (!party) throw Error(`journal_settlement_missing_application_party:${document.sourceTransactionId}`);
      const positiveRole = document.sourceTransactionType === "Payment" ? "JournalReceivable" : "JournalPayable";
      const roles = [positiveRole, document.sourceTransactionType === "Payment" ? "JournalCustomerCredit" : "JournalVendorCredit"];
      const candidates = roles.flatMap(role => candidatesByIdentity.get(JSON.stringify([role, link.sourceTransactionId, party.partyId])) ?? []);
      const recordedAccounts = paymentAccounts.get(document.sourceTransactionId);
      const eligible = candidates.filter(row => !recordedAccounts?.size || recordedAccounts.has(row.group.accountId));
      if (eligible.length !== 1) throw Error(`journal_settlement_missing_or_ambiguous_party_account:${document.sourceTransactionType}:${document.sourceTransactionId}:${link.sourceTransactionId}`);
      const projection = eligible[0];
      if (!projection || projection.resource.currencyCode !== (document.currencyCode ?? facts.company.baseCurrencyCode)) throw Error("journal_settlement_currency_mismatch");
      const scope = balances.get(projection.id);
      if (!scope) throw Error("journal_settlement_missing_balance");
      // Provider line identifiers are not canonical line IDs. Until a verified
      // identifier translation is available, never silently reinterpret one.
      if (link.sourceLineId) throw Error("journal_settlement_provider_line_translation_required");
      const plan = planJournalSettlement([scope], { journalId: scope.journalId, partyId: scope.partyId, accountId: scope.accountId, amountMinor: settlementMinor(line.sourceAmount) });
      balances.set(projection.id, plan.next);
      const record: JournalSettlementEvidence = { sourceTransactionType: document.sourceTransactionType, sourceTransactionId: document.sourceTransactionId,
        documentNumber: document.transactionNumber ?? null, date: document.transactionDate, sourceLineId: line.sourceLineId ?? String(line.lineNumber),
        journalSourceId: scope.journalId, partySourceId: projection.metadata.partySourceId, accountSourceId: projection.metadata.accountSourceId,
        amount: settlementDecimal(plan.amountMinor), allocation: plan.allocation, lineIds: plan.lineIds, reason: plan.reason };
      evidence.push(record); evidenceByLine.set(lineKey(document.sourceTransactionId, record.sourceLineId), record);
      return { ...line, linkedTransactions: [{ ...link, sourceTransactionId: projection.id, sourceTransactionType: projection.resource.sourceTransactionType }] };
    }) };
  }
  return { projections, byId, rewrite, evidence, evidenceByLine, lineKey };
}
