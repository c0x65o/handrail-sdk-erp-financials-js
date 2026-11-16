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

/** Subledger projections reference the existing journal. They never enter the
 * canonical fact writer, manufacture an invoice/bill, or create a posting.
 */
export function createQuickBooksJournalProjections(facts: CanonicalAccountingFactSet, purchaseIds: ReadonlySet<string> = new Set()) {
  const accounts = new Map(facts.accounts.map(row => [row.accountId, row]));
  const parties = new Map(facts.parties.map(row => [row.partyId, row]));
  const transactions = new Map(facts.transactions.map(row => [row.transactionId, row]));
  const journalBySourceId = new Map(facts.transactions.filter(row => (row.sourceTransactionType === "JournalEntry" || (row.sourceTransactionType === "Purchase" && purchaseIds.has(row.sourceTransactionId)))).map(row => [row.sourceTransactionId, row]));
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
    if (transaction.sourceTransactionType !== "JournalEntry" && !(transaction.sourceTransactionType === "Purchase" && purchaseIds.has(transaction.sourceTransactionId) && side === "ar")) {
      const set = paymentAccounts.get(transaction.sourceTransactionId) ?? new Set<string>();
      set.add(posting.accountId); paymentAccounts.set(transaction.sourceTransactionId, set); continue;
    }
    const net = settlementMinor(posting.debitAmount) - settlementMinor(posting.creditAmount);
    if (!posting.partyId) { if (net !== 0n) throw Error(`journal_settlement_missing_party:${transaction.sourceTransactionId}:${posting.accountId}`); continue; }
    const party = parties.get(posting.partyId);
    if (!party || party.partyType !== (side === "ar" ? "customer" : "vendor")) throw Error(`journal_settlement_invalid_party:${transaction.sourceTransactionId}`);
    const key = JSON.stringify([transaction.transactionId, posting.partyId, posting.accountId]);
    const prior = groups.get(key);
    const amount = side === "ar" ? net : -net;
    const lineId = posting.transactionLineId ?? posting.postingId;
    const lines = new Map((prior?.lines ?? []).map(line => [line.lineId, line.openMinor]));
    lines.set(lineId, (lines.get(lineId) ?? 0n) + amount);
    groups.set(key, { journalId: transaction.sourceTransactionId, partyId: posting.partyId, accountId: posting.accountId,
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
  function rewrite(document: NormalizedQuickBooksLedgerTransaction): NormalizedQuickBooksLedgerTransaction {
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
      if (!links.some(link => link.sourceTransactionType === "JournalEntry" || (["Purchase", "Check", "Expense"].includes(link.sourceTransactionType ?? "") && purchaseIds.has(link.sourceTransactionId)))) return line;
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
