/** Journal settlement amounts are independent of optional provider line allocation.
 * No posting is created by this planner. Amounts use exact minor units.
 */
export type JournalSettlementLine = {
  readonly lineId: string;
  readonly openMinor: bigint;
};
export type JournalSettlementScope = {
  readonly journalId: string;
  readonly partyId: string;
  readonly accountId: string;
  readonly openMinor: bigint;
  readonly lines: readonly JournalSettlementLine[];
  readonly lineBalancesKnown: boolean;
};
export type JournalSettlementRequest = {
  readonly journalId: string;
  readonly partyId: string;
  readonly accountId?: string;
  readonly amountMinor: bigint;
  readonly providerLineId?: string;
};
export function planJournalSettlement(scopes: readonly JournalSettlementScope[], request: JournalSettlementRequest) {
  const matching = scopes.filter(scope => scope.journalId === request.journalId && scope.partyId === request.partyId &&
    (request.accountId === undefined || scope.accountId === request.accountId));
  const scope = matching[0];
  if (matching.length !== 1 || !scope) throw Error("journal_settlement_missing_or_ambiguous_party_account");
  if (request.amountMinor <= 0n || request.amountMinor > scope.openMinor) throw Error("journal_settlement_exceeds_open_balance");
  let lineIds: string[] = [];
  let allocation: "provider_line" | "single_line" | "all_lines" | "unallocated" = "unallocated";
  if (request.providerLineId !== undefined) {
    const line = scope.lines.find(row => row.lineId === request.providerLineId);
    if (!line || !scope.lineBalancesKnown || request.amountMinor > line.openMinor) throw Error("journal_settlement_invalid_provider_line");
    lineIds = [line.lineId]; allocation = "provider_line";
  } else if (scope.lineBalancesKnown) {
    const exact = scope.lines.filter(line => line.openMinor === request.amountMinor);
    if (exact.length === 1) { lineIds = exact.map(line => line.lineId); allocation = "single_line"; }
    else if (request.amountMinor === scope.openMinor) { lineIds = scope.lines.filter(line => line.openMinor !== 0n).map(line => line.lineId); allocation = "all_lines"; }
  } else if (request.amountMinor === scope.openMinor) {
    // Closing the remaining group proves all lines settled, without reconstructing
    // the unknown split of any earlier partial payment.
    lineIds = scope.lines.map(line => line.lineId); allocation = "all_lines";
  }
  const remaining = scope.openMinor - request.amountMinor;
  return {
    journalId: scope.journalId, partyId: scope.partyId, accountId: scope.accountId,
    amountMinor: request.amountMinor, allocation, lineIds,
    reason: allocation === "unallocated" ? "provider gave no line id; partial amount" : null,
    next: { ...scope, openMinor: remaining,
      lineBalancesKnown: remaining === 0n || (scope.lineBalancesKnown && allocation !== "unallocated"),
      lines: scope.lines.map(line => ({ ...line, openMinor: remaining === 0n ? 0n :
        lineIds.includes(line.lineId) ? line.openMinor - request.amountMinor : line.openMinor })) }
  };
}
