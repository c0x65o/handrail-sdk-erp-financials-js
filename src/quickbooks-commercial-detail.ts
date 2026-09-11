import { createHash } from "node:crypto";
import type { NormalizedQuickBooksLedgerLine, NormalizedQuickBooksLedgerTransaction } from "./normalized-accounting-contracts.js";

export const QUICKBOOKS_COMMERCIAL_DETAIL_VERSION = 2;
export type QuickBooksCommercialReferences = {
  accounts: readonly { sourceAccountId: string; accountId: string }[];
  items: readonly { sourceItemId: string; itemId: string; incomeAccountId?: string; expenseAccountId?: string }[];
};
export type QuickBooksCommercialLine = {
  source: NormalizedQuickBooksLedgerLine;
  accountId: string;
  itemId?: string;
  quantity: string;
  unitAmount: string;
  discountAmount: string;
  taxAmount: string;
  amount: string;
};
export type QuickBooksCommercialDetailPlan = {
  version: number;
  fingerprint: string;
  totalTax: string;
  lines: readonly QuickBooksCommercialLine[];
};
export class QuickBooksCommercialDetailError extends Error {
  readonly code = "quickbooks_commercial_detail_incomplete";
  constructor(readonly sourceTransactionId: string, readonly reason: string) {
    super(`QuickBooks document ${sourceTransactionId}: ${reason}`);
  }
}

/** Projects provider commercial evidence only. Journal polarity never substitutes for invoice lines. */
export function planQuickBooksCommercialDetail(
  document: NormalizedQuickBooksLedgerTransaction,
  references: QuickBooksCommercialReferences
): QuickBooksCommercialDetailPlan {
  const fail = (reason: string): never => { throw new QuickBooksCommercialDetailError(document.sourceTransactionId, reason); };
  const parse = (value: string | undefined, field: string): bigint => {
    if (value === undefined || !/^-?\d+(?:\.\d{1,12})?$/.test(value)) return fail(`missing_or_invalid_${field}`);
    return decimal(value);
  };
  const total = round(parse(document.totalAmount, "total"), 10_000_000_000n);
  const accounts = new Map(references.accounts.map(account => [account.sourceAccountId, account.accountId]));
  const items = new Map(references.items.map(item => [item.sourceItemId, item]));
  const sale = ["Invoice", "CreditMemo", "RefundReceipt", "SalesReceipt"].includes(document.sourceTransactionType);
  const sourceLines = document.lines.filter(line => !["SubTotalLineDetail", "DescriptionOnly", "DescriptionOnlyLineDetail", "GroupLineDetail"].includes(line.detailType ?? ""));
  if (sourceLines.length === 0) fail("missing_commercial_lines");
  const identities = new Set<string>();
  const numbers = new Set<number>();
  const candidates = sourceLines.map(source => {
    if (!Number.isSafeInteger(source.lineNumber) || source.lineNumber <= 0 || numbers.has(source.lineNumber)) fail("duplicate_or_invalid_line_number");
    numbers.add(source.lineNumber);
    const identity = source.sourceLineId ?? String(source.lineNumber);
    if (identities.has(identity)) fail("duplicate_source_line");
    identities.add(identity);
    let net = round(parse(source.sourceAmount, "source_line_amount"), 10_000_000_000n);
    const discount = source.detailType === "DiscountLineDetail";
    if (discount) net = -abs(net);
    const item = source.itemRef ? items.get(source.itemRef.sourceObjectId) : undefined;
    const accountId = source.accountRef ? accounts.get(source.accountRef.sourceObjectId)
      : sale ? item?.incomeAccountId : item?.expenseAccountId;
    if (!accountId) fail("unresolved_line_account");
    if (source.itemRef && !item) fail("unresolved_line_item");
    let quantity = source.sourceQuantity;
    let unitAmount = source.sourceUnitAmount;
    if (discount) { quantity = "1"; unitAmount = money(net); }
    else if (quantity === undefined && unitAmount === undefined && !source.itemRef
      && source.detailType !== "ItemBasedExpenseLineDetail") {
      // Amount-only account and reimbursed-expense lines have no provider quantity semantics.
      quantity = "1"; unitAmount = money(net);
    }
    const q = parse(quantity, "quantity");
    const u = parse(unitAmount, "unit_price");
    if (q === 0n && net !== 0n) fail("zero_quantity_with_amount");
    return { source, accountId: accountId!, ...(item ? { itemId: item.itemId } : {}), quantity: quantity!, unitAmount: unitAmount!, net, gross: round(q * u, 10_000_000_000_000_000_000_000n) };
  });
  const sum = candidates.reduce((value, line) => value + line.net, 0n);
  // Old envelopes may omit tax only when their commercial amounts already explain the total.
  const tax = document.totalTax === undefined ? (sum === total ? 0n : fail("missing_document_tax"))
    : round(parse(document.totalTax, "document_tax"), 10_000_000_000n);
  const inclusive = document.taxCalculation === "TaxInclusive";
  // Canonical prices currently have no inclusive-tax basis flag. Do not relabel tax as a discount.
  if (inclusive && tax !== 0n) fail("unsupported_tax_inclusive_detail");
  if (sum + (inclusive ? 0n : tax) !== total) fail("commercial_total_mismatch");
  const weights = candidates.map(line => line.source.taxCode === "TAX" ? line.net : 0n);
  const denominator = weights.reduce((value, weight) => value + weight, 0n);
  if (tax !== 0n && denominator <= 0n) fail("unresolved_tax_allocation");
  const taxes = weights.map(weight => tax === 0n ? 0n : tax * weight / denominator);
  let remainder = tax - taxes.reduce((value, amount) => value + amount, 0n);
  // Stable largest-remainder allocation of the authoritative document tax.
  const order = weights.map((weight, index) => ({ index, remainder: denominator === 0n ? 0n : tax * weight % denominator }))
    .filter(({ index }) => weights[index] !== 0n)
    .sort((a, b) => abs(a.remainder) === abs(b.remainder) ? a.index - b.index : abs(a.remainder) > abs(b.remainder) ? -1 : 1);
  for (const { index } of order) {
    if (remainder === 0n) break;
    const cent = remainder > 0n ? 1n : -1n;
    taxes[index] = taxes[index]! + cent;
    remainder -= cent;
  }
  if (remainder !== 0n) fail("unresolved_tax_rounding");
  const lines = candidates.map((line, index): QuickBooksCommercialLine => {
    const lineTax = taxes[index]!;
    const net = inclusive ? line.net - lineTax : line.net;
    const sign = line.gross < 0n ? -1n : 1n;
    const discount = (line.gross - net) * sign;
    if (discount < 0n || discount > abs(line.gross)) fail("line_price_arithmetic_mismatch");
    return { source: line.source, accountId: line.accountId, ...(line.itemId ? { itemId: line.itemId } : {}),
      quantity: line.quantity, unitAmount: line.unitAmount, discountAmount: money(discount),
      taxAmount: money(lineTax), amount: money(net + lineTax) };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: QUICKBOOKS_COMMERCIAL_DETAIL_VERSION,
    sourceTransactionId: document.sourceTransactionId, sourceTransactionType: document.sourceTransactionType,
    sourceUpdatedAt: document.sourceUpdatedAt, total: money(total), tax: money(tax), lines })).digest("hex");
  return { version: QUICKBOOKS_COMMERCIAL_DETAIL_VERSION, fingerprint, totalTax: money(tax), lines };
}

function decimal(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return (negative ? -1n : 1n) * (BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0")));
}
function abs(value: bigint): bigint { return value < 0n ? -value : value; }
function round(value: bigint, divisor: bigint): bigint { return (value < 0n ? -1n : 1n) * ((abs(value) + divisor / 2n) / divisor); }
function money(value: bigint): string { return `${value < 0n ? "-" : ""}${abs(value) / 100n}.${String(abs(value) % 100n).padStart(2, "0")}`; }
