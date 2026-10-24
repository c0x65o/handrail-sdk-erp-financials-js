import type { AccountClassification } from "./canonical-model.js";
import type { InvoiceAccountPolicy } from "./invoice-account-policy.js";
import { ErpFinancialsError } from "./sdk-errors.js";
import type { ErpFinancialsAccountReference, PostJournalEntryLineInput } from "./erp-financials-service.js";
import type { NormalizedCommercialDocumentLine } from "./commercial-lines.js";

/** Optional explicit posting identities. Absence retains the historical net
 * revenue treatment; a configured invoice policy may require these identities. */
export type InvoicePostingComponents = {
  readonly taxAccount?: ErpFinancialsAccountReference;
  readonly discountAccount?: ErpFinancialsAccountReference;
};

export function normalizeInvoiceComponents(input: InvoicePostingComponents): InvoicePostingComponents {
  const reference = (value: unknown): ErpFinancialsAccountReference => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const keys = Object.keys(value);
    if (keys.length !== 1 || !["accountId", "accountKey"].includes(keys[0] ?? "")) throw invalid();
    const candidate = value as Record<string, unknown>;
    const field = keys[0];
    if(field===undefined)throw invalid();
    const id = candidate[field];
    if (typeof id !== "string" || !id.trim()) throw invalid();
    return field === "accountId" ? {accountId:id} : {accountKey:id};
  };
  return {
    ...(input.taxAccount === undefined ? {} : {taxAccount:reference(input.taxAccount)}),
    ...(input.discountAccount === undefined ? {} : {discountAccount:reference(input.discountAccount)}),
  };
}

/** Exact components of one customer-facing line, including its dimensions.
 * Tax leaves income; an explicit discount account receives the contra debit.
 * Reversal swaps every component, rather than guessing from the net amount. */
export function invoiceComponentJournalLines(
  line: ErpFinancialsAccountReference & NormalizedCommercialDocumentLine & InvoicePostingComponents,
  customerId: string,
  reverse = false,
): readonly PostJournalEntryLineInput[] {
  const net = minor(line.amount), tax = minor(line.taxAmount), discount = minor(line.discountAmount);
  const revenue = net - (line.taxAccount ? tax : 0n) + (line.discountAccount ? discount : 0n);
  if (revenue < 0n) throw invalid();
  const common = {partyId:customerId,dimensionRefs:line.dimensionRefs,
    ...(line.itemId === undefined ? {} : {itemId:line.itemId}),
    ...(line.description === undefined ? {} : {description:line.description})};
  const entry = (account: ErpFinancialsAccountReference, amount: bigint, debit: boolean): PostJournalEntryLineInput[] =>
    amount === 0n ? [] : [{...account,...common,...(debit !== reverse ? {debit:money(amount)} : {credit:money(amount)})}];
  const account = line.accountKey === undefined ? {accountId:line.accountId} : {accountKey:line.accountKey};
  return [...entry(account,revenue,false),
    ...(line.taxAccount ? entry(line.taxAccount,tax,false) : []),
    ...(line.discountAccount ? entry(line.discountAccount,discount,true) : [])];
}
export function invoiceComponentRequirements(line: InvoicePostingComponents, policy: InvoiceAccountPolicy | undefined,
  resolve: (reference: ErpFinancialsAccountReference)=>string): readonly {accountId:string;classifications:readonly AccountClassification[]}[] {
  return [...(line.taxAccount ? [{accountId:resolve(line.taxAccount),classifications:policy?.taxClassifications ?? ["liability"] as const}] : []),
    ...(line.discountAccount ? [{accountId:resolve(line.discountAccount),classifications:policy?.discountClassifications ?? ["income","other_income"] as const}] : [])];
}
export function assertInvoiceComponentPolicy(line: NormalizedCommercialDocumentLine & InvoicePostingComponents,
  policy: InvoiceAccountPolicy | undefined, controlId: string, resolve:(reference:ErpFinancialsAccountReference)=>string): void {
  for(const [amount,reference,required] of [[line.taxAmount,line.taxAccount,policy?.taxClassifications],
    [line.discountAmount,line.discountAccount,policy?.discountClassifications]] as const){
    if ((required && minor(amount)>0n && !reference) || (reference && (minor(amount)===0n || resolve(reference)===controlId))) {
      throw new ErpFinancialsError("invalid_input","Invoice tax and discount components require distinct posting accounts and positive component amounts");
    }
  }
}
function minor(value: string): bigint {
  const match=/^(\d+)\.(\d{2})$/.exec(value);
  if (!match || match[1]===undefined || match[2]===undefined) throw invalid();
  return BigInt(match[1])*100n+BigInt(match[2]);
}
function money(value: bigint): string {return `${String(value/100n)}.${String(value%100n).padStart(2,"0")}`;}
function invalid(): ErpFinancialsError {return new ErpFinancialsError("invalid_input","Invoice posting components are invalid");}
