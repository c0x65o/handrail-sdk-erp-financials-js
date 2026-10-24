import { createHash } from "node:crypto";

import type { DecimalString, IsoDate, LedgerPosting } from "./canonical-model.js";

export type StandardAccountingMethod = "cash" | "accrual";
export type ManualJournalAccountingPolicy = "configured_basis_only" | "mirror_cash_and_accrual";
export type CashBasisApplicationType =
  | "customer_payment_to_invoice"
  | "bill_payment_to_bill"
  | "customer_refund_against_invoice";
export type CashBasisProjectionAction = "recognize" | "reverse";

export type CashBasisApplicationProjectionInput = {
  readonly applicationId: string;
  readonly applicationType: CashBasisApplicationType;
  readonly action: CashBasisProjectionAction;
  readonly appliedAmount: DecimalString;
  readonly effectiveDate: IsoDate;
  readonly importBatchId: string;
  readonly accrualPostings: readonly LedgerPosting[];
  /** Explicit receivable/payable control for journals with contra components.
   * Caller supplies the remaining unrecognized journal for a new allocation,
   * or the exact original allocation for reversal. */
  readonly controlAccountId?: string;
};

/**
 * Materializes the cash-basis view of an invoice or bill application. A partial
 * application recognizes each original line proportionally (largest remainder),
 * while retaining its dimensions and source provenance. Unapply/void uses the
 * same deterministic allocation with debit and credit reversed.
 */
export function projectCashBasisApplication(input: CashBasisApplicationProjectionInput): readonly LedgerPosting[] {
  const postings = input.accrualPostings;
  const first = postings[0];
  if (first === undefined) throw new Error("Cash-basis projection requires accrual postings");
  if (postings.some((posting) => posting.accountingBasis !== "accrual")) {
    throw new Error("Cash-basis projection accepts accrual postings only");
  }
  if (postings.some((posting) => posting.tenantId !== first.tenantId || posting.sourceId !== first.sourceId || posting.transactionId !== first.transactionId || posting.currencyCode !== first.currencyCode)) {
    throw new Error("Cash-basis projection postings must share scope, transaction, and currency");
  }
  const debit = postings.reduce((sum, posting) => sum + moneyMinor(posting.debitAmount), 0n);
  const credit = postings.reduce((sum, posting) => sum + moneyMinor(posting.creditAmount), 0n);
  if (debit === 0n || debit !== credit) throw new Error("Cash-basis projection source journal must be balanced");
  const applied = moneyMinor(input.appliedAmount);
  if (applied <= 0n || applied > debit) throw new Error("Applied amount must be positive and no greater than the source journal total");

  let debitAllocations: readonly bigint[], creditAllocations: readonly bigint[];
  if (input.controlAccountId === undefined) {
    debitAllocations = allocate(postings.map(posting=>moneyMinor(posting.debitAmount)),applied,debit);
    creditAllocations = allocate(postings.map(posting=>moneyMinor(posting.creditAmount)),applied,credit);
  } else {
    const controlIsDebit = input.applicationType !== "bill_payment_to_bill";
    const matches=postings.flatMap((posting,index)=>posting.accountId===input.controlAccountId?[index]:[]);
    if(matches.length!==1)throw new Error("Cash-basis projection requires one explicit control posting");
    const controlIndex=matches[0];
    if(controlIndex===undefined)throw new Error("Missing control index");
    const control=postings[controlIndex];
    if(control===undefined)throw new Error("Missing control posting");
    const controlAmount=moneyMinor(controlIsDebit?control.debitAmount:control.creditAmount);
    if(controlAmount<=0n || moneyMinor(controlIsDebit?control.creditAmount:control.debitAmount)!==0n || applied>controlAmount
      || postings.some(posting=>moneyMinor(posting.debitAmount)<0n||moneyMinor(posting.creditAmount)<0n)) {
      throw new Error("Applied amount must be positive and no greater than the control balance");
    }
    const sameSide=postings.map((posting,index)=>index===controlIndex?0n:moneyMinor(controlIsDebit?posting.debitAmount:posting.creditAmount));
    const contraTotal=sameSide.reduce((sum,value)=>sum+value,0n);
    const contraShare=(contraTotal*applied*2n+controlAmount)/(controlAmount*2n);
    const controlled=contraTotal===0n?postings.map(()=>0n):[...allocate(sameSide,contraShare,contraTotal)];
    controlled[controlIndex]=applied;
    const opposite=allocate(postings.map(posting=>moneyMinor(controlIsDebit?posting.creditAmount:posting.debitAmount)),applied+contraShare,debit);
    [debitAllocations,creditAllocations]=controlIsDebit?[controlled,opposite]:[opposite,controlled];
  }
  return postings.flatMap((posting, index) => {
    let projectedDebit = debitAllocations[index] ?? 0n;
    let projectedCredit = creditAllocations[index] ?? 0n;
    if (projectedDebit === 0n && projectedCredit === 0n) return [];
    if (input.action === "reverse") [projectedDebit, projectedCredit] = [projectedCredit, projectedDebit];
    const identity = [input.applicationId, input.action, posting.sourcePostingId].join("\u0000");
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
    return [{
      ...posting,
      postingId: `posting_cash_${digest}`,
      sourcePostingId: `cash-application:${input.applicationId}:${input.action}:${posting.sourcePostingId}`,
      postingDate: input.effectiveDate,
      accountingBasis: "cash" as const,
      debitAmount: minorMoney(projectedDebit),
      creditAmount: minorMoney(projectedCredit),
      netAmount: minorMoney(projectedDebit - projectedCredit),
      importBatchId: input.importBatchId
    }];
  });
}

function allocate(amounts: readonly bigint[], target: bigint, total: bigint): readonly bigint[] {
  const shares = amounts.map((amount, index) => ({ index, floor: amount * target / total, remainder: amount * target % total }));
  let remaining = target - shares.reduce((sum, share) => sum + share.floor, 0n);
  for (const share of [...shares].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)) {
    if (remaining === 0n) break;
    if ((amounts[share.index] ?? 0n) > 0n) { share.floor += 1n; remaining -= 1n; }
  }
  return shares.sort((left, right) => left.index - right.index).map((share) => share.floor);
}

function moneyMinor(value: DecimalString): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) throw new Error(`Invalid money value: ${value}`);
  const whole = match[2];
  if (whole === undefined) throw new Error(`Invalid money value: ${value}`);
  const amount = BigInt(whole) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -amount : amount;
}

function minorMoney(value: bigint): DecimalString {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
